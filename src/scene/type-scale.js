/**
 * From a rendered text run to the `TextStyle` that will actually apply to it.
 *
 * One function, one direction: a role name (`data-pp-tx`) plus a breakpoint
 * plus the brand produces the style. `scenes.css` styles the same attribute
 * from the same tokens, so what the overflow detector measures is what the
 * client sees — which is the whole point of §22.2.
 *
 * The family reported is the brand's *requested* family, with its fallback
 * stack alongside it. L11 resolves it with `resolveFace(...)` and measures
 * against `.resolved`; that is what "post-substitution" means, and doing the
 * substitution here as well would do it twice.
 *
 * @module scene/type-scale
 */

import { TYPE_ROLES } from './tokens.js';
import { faceFor } from './brand-access.js';

/**
 * @typedef {object} RoleStyle
 * @property {import('../core/text-metrics.js').TextStyle} style
 * @property {string[]} fontStack   the CSS stack the family sits at the head of
 * @property {'display'|'body'|'mono'} face
 */

/**
 * @param {string} role                 a `data-pp-tx` value
 * @param {'sm'|'md'|'lg'} bp
 * @param {import('../core/contracts.d.ts').BrandSystem|null} brand
 * @param {{scale?: number}} [options]  SVG roles are drawn in design units and
 *                                      scale with the drawing
 * @returns {RoleStyle}
 */
export function styleForRole(role, bp, brand, options = {}) {
  const spec = TYPE_ROLES[role];
  if (!spec) throw new Error(`scene/type-scale: unknown text role "${role}"`);
  const scale = spec.svg ? (options.scale ?? 1) : 1;
  const face = faceFor(brand, spec.face);
  const fontSizePx = round4(spec.sizes[bp] * scale);
  /** @type {import('../core/text-metrics.js').TextStyle} */
  const style = {
    family: face.family,
    weight: spec.weight,
    fontSizePx,
    lineHeight: spec.lineHeight,
    letterSpacingPx: round4((spec.letterSpacingEm || 0) * fontSizePx),
    textTransform: spec.textTransform || 'none',
  };
  return { style, fontStack: face.fallbackStack, face: spec.face };
}

/** @param {number} n @returns {number} */
function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/** Every role a layout may stamp. @returns {string[]} */
export function textRoles() {
  return Object.keys(TYPE_ROLES);
}
