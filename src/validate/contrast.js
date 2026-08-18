/**
 * §14 — every text/background pair, computed, at severity 1 for body text below
 * 4.5:1.
 *
 * The palette arrives from L4 already solved (§7 requires every `onX` role to
 * reach 4.5:1 against its pair, and `solveRoles` throws rather than return a
 * failing palette). This module does not trust that. A brand can be hand-edited
 * in the studio, imported from an older project, or assembled by a lane that
 * changes next month, and the client sees the result either way — so the
 * contrast is recomputed here, exactly, from the hex values that will actually
 * be written into the artifact's stylesheet.
 *
 * Three families of pair are checked:
 *
 *  1. Every `FOREGROUND_ROLES` entry against `ROLE_PAIR` at the 4.5:1 body
 *     minimum. This is the §14 sentence, verbatim.
 *  2. The illustrative-content label against its own background. §18.1 says the
 *     label "cannot be styled to invisibility", and a label the palette itself
 *     makes unreadable is exactly that, arrived at by accident instead of by
 *     intent.
 *  3. Brand colours used as display text, at the 3:1 large-text minimum — but
 *     only when the type scale actually makes them large. Where it does not,
 *     they are held to 4.5:1 like any other text.
 *
 * Non-text pairs (the border rule, the status fills) are measured against the
 * 3:1 non-text minimum and warn rather than block, because nothing is read off
 * them.
 *
 * @module validate/contrast
 */

import {
  FOREGROUND_ROLES, ROLE_PAIR, CONTRAST_AA_BODY, CONTRAST_AA_LARGE, CONTRAST_AA_NONTEXT,
} from '../core/contracts.js';
import { contrastRatio } from './lane-brand.js';
import { makeFinding, sortFindings } from './finding.js';

/**
 * The display type scale, in CSS px per breakpoint. It has to live somewhere for
 * "where the type scale makes them large" to mean anything; it is stated here
 * and used only for the WCAG large-text decision, never for measurement (that is
 * L8's `measureScene`).
 */
export const DISPLAY_SIZE_PX = { sm: 28, md: 40, lg: 52 };

/** WCAG 2.1 large text: >= 24px, or >= 18.66px when bold. */
export const LARGE_TEXT_MIN_PX = 24;
/** @see LARGE_TEXT_MIN_PX */
export const LARGE_TEXT_BOLD_MIN_PX = 18.66;
/** The weight at which WCAG considers text bold. */
export const BOLD_WEIGHT = 700;

/** The pair the illustrative-content label is rendered with (§9, `pp-provenance`). */
export const PROVENANCE_PAIR = { fg: 'onSurfaceAlt', bg: 'surfaceAlt' };

/** Brand colours the artifact may set display text in, and the surfaces under them. */
const DISPLAY_TEXT_PAIRS = [
  { fg: 'primary', bg: 'surface' },
  { fg: 'primary', bg: 'surfaceAlt' },
  { fg: 'secondary', bg: 'surface' },
  { fg: 'accent', bg: 'surface' },
];

/** Pairs nothing is read off: rules, dividers, status dots and fills. */
const NON_TEXT_PAIRS = [
  { fg: 'border', bg: 'surface', what: 'the border and divider colour' },
  { fg: 'success', bg: 'surface', what: 'the success status colour' },
  { fg: 'warning', bg: 'surface', what: 'the warning status colour' },
  { fg: 'danger', bg: 'surface', what: 'the danger status colour' },
];

/**
 * Whether the display type scale makes brand-coloured headlines "large text"
 * under WCAG. The smallest breakpoint decides, because it is the one that has to
 * hold: a headline that is large at `lg` and small at `sm` is small text.
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @returns {{large: boolean, sizePx: number, bold: boolean}}
 */
export function displayTextIsLarge(brand) {
  const sizes = Object.values(DISPLAY_SIZE_PX);
  const sizePx = Math.min(...sizes);
  const display = ((brand && brand.faces) || []).find((f) => f.role === 'display');
  const weights = ((display && display.weightsSeen) || []).slice().sort((a, b) => a - b);
  const weight = weights.length ? weights[weights.length - 1] : 400;
  const bold = weight >= BOLD_WEIGHT;
  const large = sizePx >= LARGE_TEXT_MIN_PX || (bold && sizePx >= LARGE_TEXT_BOLD_MIN_PX);
  return { large, sizePx, bold };
}

/**
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @returns {Map<string, import('../core/contracts.d.ts').ColorToken>}
 */
function colorIndex(brand) {
  /** @type {Map<string, any>} */
  const map = new Map();
  for (const token of (brand && brand.colors) || []) {
    if (token && typeof token.hex === 'string' && !map.has(token.role)) map.set(token.role, token);
  }
  return map;
}

/** Format a ratio the way WCAG writes one. */
function ratioText(r) {
  return `${(Math.round(r * 100) / 100).toFixed(2)}:1`;
}

/**
 * §14's contrast sweep over a brand system.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @param {object} [deps]
 * @param {(a: string, b: string) => number} [deps.contrastRatio]
 * @returns {import('../core/contracts.d.ts').Finding[]}
 */
export function checkContrast(brand, deps = {}) {
  const ratioOf = deps.contrastRatio || contrastRatio;
  const colors = colorIndex(brand);
  /** @type {any[]} */
  const out = [];
  const scale = displayTextIsLarge(brand);

  /**
   * @param {object} spec
   * @param {string} spec.fg
   * @param {string} spec.bg
   * @param {number} spec.minimum
   * @param {'body'|'large'|'nontext'} spec.kind
   * @param {string} spec.what
   * @param {1|2} spec.severity
   * @param {string} [spec.extra]
   */
  const check = (spec) => {
    const fg = colors.get(spec.fg);
    const bg = colors.get(spec.bg);
    if (!fg || !bg) return;
    let ratio;
    try {
      ratio = ratioOf(fg.hex, bg.hex);
    } catch (e) {
      // An unparseable hex is a shape violation, reported by validateProofShape;
      // contrast has nothing to say about it and must not crash the sweep.
      return;
    }
    if (!(ratio < spec.minimum)) return;
    const remedy = spec.kind === 'nontext'
      ? `Darken or lighten ${spec.fg} until it clears ${spec.minimum}:1 against ${spec.bg}.`
      : `Derive a compliant ${spec.fg} by walking its lightness in OKLCH against ${spec.bg}; auto-fix can do it.`;
    out.push(makeFinding({
      code: 'CONTRAST_FAIL',
      severity: spec.severity,
      key: `pair:${spec.fg}/${spec.bg}:${spec.kind}`,
      autoFixAvailable: spec.kind !== 'nontext',
      message: `${spec.what} measures ${ratioText(ratio)} — below the ${spec.minimum}:1 ${spec.kind === 'nontext' ? 'non-text' : spec.kind === 'large' ? 'large-text' : 'body-text'} minimum. ${fg.hex} on ${bg.hex}.${spec.extra ? ` ${spec.extra}` : ''} ${remedy}`,
      detail: {
        foregroundRole: spec.fg,
        backgroundRole: spec.bg,
        foregroundHex: fg.hex,
        backgroundHex: bg.hex,
        ratio: Math.round(ratio * 10000) / 10000,
        minimum: spec.minimum,
        kind: spec.kind,
      },
    }));
  };

  // 1. Every foreground role against its designated pair, at the body minimum.
  for (const role of FOREGROUND_ROLES) {
    const pair = ROLE_PAIR[role];
    if (!pair) continue;
    const isProvenance = role === PROVENANCE_PAIR.fg && pair === PROVENANCE_PAIR.bg;
    check({
      fg: role,
      bg: pair,
      minimum: CONTRAST_AA_BODY,
      kind: 'body',
      severity: 1,
      what: `Body text in ${role} on ${pair}`,
      extra: isProvenance
        ? 'This pair also carries the illustrative-content label, which §18.1 forbids rendering below legibility.'
        : undefined,
    });
  }

  // 2. The illustrative-content label against its own background, when it is not
  //    already covered by a foreground role above.
  if (!FOREGROUND_ROLES.includes(PROVENANCE_PAIR.fg) || ROLE_PAIR[PROVENANCE_PAIR.fg] !== PROVENANCE_PAIR.bg) {
    check({
      fg: PROVENANCE_PAIR.fg,
      bg: PROVENANCE_PAIR.bg,
      minimum: CONTRAST_AA_BODY,
      kind: 'body',
      severity: 1,
      what: 'The illustrative-content label',
      extra: '§18.1 requires it to stay legible; the label may not be styled, or coloured, to invisibility.',
    });
  }

  // 3. Brand colours used as display text, at the minimum the type scale earns.
  for (const pair of DISPLAY_TEXT_PAIRS) {
    check({
      fg: pair.fg,
      bg: pair.bg,
      minimum: scale.large ? CONTRAST_AA_LARGE : CONTRAST_AA_BODY,
      kind: scale.large ? 'large' : 'body',
      severity: 1,
      what: `Display text in ${pair.fg} on ${pair.bg} (${scale.sizePx}px${scale.bold ? ' bold' : ''} at the smallest breakpoint)`,
    });
  }

  // 4. Non-text pairs, at the 3:1 non-text minimum.
  for (const pair of NON_TEXT_PAIRS) {
    check({
      fg: pair.fg,
      bg: pair.bg,
      minimum: CONTRAST_AA_NONTEXT,
      kind: 'nontext',
      severity: 2,
      what: `${pair.what[0].toUpperCase()}${pair.what.slice(1)} against ${pair.bg}`,
    });
  }

  return sortFindings(out);
}

/**
 * Every pair `checkContrast` inspects, with its measured ratio and the minimum
 * it is held to. The studio's brand inspector shows this table; the tests use it
 * to assert that a compliant palette really was measured rather than skipped.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @param {object} [deps]
 * @param {(a: string, b: string) => number} [deps.contrastRatio]
 * @returns {{fg: string, bg: string, kind: string, minimum: number, ratio: number|null, passes: boolean}[]}
 */
export function contrastReport(brand, deps = {}) {
  const ratioOf = deps.contrastRatio || contrastRatio;
  const colors = colorIndex(brand);
  const scale = displayTextIsLarge(brand);
  /** @type {{fg: string, bg: string, kind: string, minimum: number}[]} */
  const pairs = [];
  for (const role of FOREGROUND_ROLES) {
    if (ROLE_PAIR[role]) pairs.push({ fg: role, bg: ROLE_PAIR[role], kind: 'body', minimum: CONTRAST_AA_BODY });
  }
  if (!pairs.some((p) => p.fg === PROVENANCE_PAIR.fg && p.bg === PROVENANCE_PAIR.bg)) {
    pairs.push({ fg: PROVENANCE_PAIR.fg, bg: PROVENANCE_PAIR.bg, kind: 'body', minimum: CONTRAST_AA_BODY });
  }
  for (const p of DISPLAY_TEXT_PAIRS) {
    pairs.push({ fg: p.fg, bg: p.bg, kind: scale.large ? 'large' : 'body', minimum: scale.large ? CONTRAST_AA_LARGE : CONTRAST_AA_BODY });
  }
  for (const p of NON_TEXT_PAIRS) pairs.push({ fg: p.fg, bg: p.bg, kind: 'nontext', minimum: CONTRAST_AA_NONTEXT });

  return pairs.map((p) => {
    const fg = colors.get(p.fg);
    const bg = colors.get(p.bg);
    let ratio = null;
    if (fg && bg) {
      try { ratio = Math.round(ratioOf(fg.hex, bg.hex) * 10000) / 10000; } catch (e) { ratio = null; }
    }
    return { ...p, ratio, passes: ratio === null ? true : ratio >= p.minimum };
  });
}
