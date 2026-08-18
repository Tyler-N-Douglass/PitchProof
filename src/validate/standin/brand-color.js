/**
 * STAND-IN for L4's `src/brand/color.js` (`API.md` Part 3 → L4).
 *
 * Only the two functions L11 is declared to consume are here: `contrastRatio`
 * and `deriveForContrast`. Both are written to the same definitions the real
 * module must satisfy — WCAG 2.1 relative luminance computed exactly, and a
 * lightness walk that holds hue — so swapping the bridge over changes nothing
 * L11 depends on.
 *
 * @module validate/standin/brand-color
 */

/**
 * sRGB channel (0..1) to linear light. WCAG 2.1, exact.
 * @param {number} c
 * @returns {number}
 */
export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * @param {string} hex  #RGB or #RRGGBB
 * @returns {[number, number, number]} 0..255
 */
export function hexToRgb(hex) {
  const s = String(hex).trim().replace(/^#/, '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`hexToRgb: not a hex colour: ${String(hex)}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

/**
 * @param {[number, number, number]} rgb 0..255
 * @returns {string}
 */
export function rgbToHex(rgb) {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * WCAG 2.1 relative luminance.
 * @param {[number, number, number]} rgb 0..255
 * @returns {number}
 */
export function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => srgbToLinear(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.1 contrast ratio between two colours.
 * @param {string} hexA
 * @param {string} hexB
 * @returns {number}
 */
export function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Walk `baseHex` lighter or darker until it reaches `minRatio` against
 * `targetHex`, holding hue by scaling the channels around the achromatic axis.
 * Returns the first colour that satisfies the constraint, or the extreme (white
 * or black) if none does.
 *
 * @param {string} baseHex
 * @param {string} targetHex
 * @param {number} minRatio
 * @returns {string}
 */
export function deriveForContrast(baseHex, targetHex, minRatio) {
  if (contrastRatio(baseHex, targetHex) >= minRatio) return baseHex;
  const base = hexToRgb(baseHex);
  const targetL = relativeLuminance(hexToRgb(targetHex));
  // Walk away from the target's luminance: darker when the target is light.
  const towardWhite = targetL < 0.18;
  const steps = 256;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    /** @type {[number, number, number]} */
    const candidate = towardWhite
      ? [base[0] + (255 - base[0]) * t, base[1] + (255 - base[1]) * t, base[2] + (255 - base[2]) * t]
      : [base[0] * (1 - t), base[1] * (1 - t), base[2] * (1 - t)];
    const hex = rgbToHex(candidate);
    if (contrastRatio(hex, targetHex) >= minRatio) return hex;
  }
  return towardWhite ? '#FFFFFF' : '#000000';
}

// ---------------------------------------------------------------------------
// OKLab / OKLCH — needed so a derived colour keeps `ColorToken.oklch` honest
// ---------------------------------------------------------------------------

/**
 * @param {[number, number, number]} rgb 0..255
 * @returns {[number, number, number]} OKLab
 */
export function rgbToOklab(rgb) {
  const r = srgbToLinear(rgb[0] / 255);
  const g = srgbToLinear(rgb[1] / 255);
  const b = srgbToLinear(rgb[2] / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

/**
 * @param {[number, number, number]} lab
 * @returns {[number, number, number]} L (0..1), C, H (degrees 0..360)
 */
export function oklabToOklch(lab) {
  const [L, a, b] = lab;
  const C = Math.sqrt(a * a + b * b);
  let H = (Math.atan2(b, a) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

/**
 * @param {string} hex
 * @returns {[number, number, number]} OKLCH
 */
export function hexToOklch(hex) {
  return oklabToOklch(rgbToOklab(hexToRgb(hex)));
}
