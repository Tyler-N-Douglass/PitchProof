/**
 * Reading a `BrandSystem` safely from inside a layout.
 *
 * Layouts run in three places — the studio preview, the rehearsal sweep, and
 * the artifact — and in the studio the brand is half-extracted for most of the
 * session. A layout that threw on a missing face would make the preview
 * useless exactly when the user needs it. So every read goes through here and
 * every read has a neutral answer.
 *
 * The neutral answers deliberately mirror the defaults in
 * `src/runtime/runtime.css`, so an un-themed preview measures as what it
 * renders. §15's law that the artifact never wears the studio palette is kept
 * by construction: nothing in this module knows the studio exists.
 *
 * @module scene/brand-access
 */

import { FALLBACK_CANDIDATES, normalizeFamily, resolveFace } from '../core/text-metrics.js';

/** The default stacks, matching `--pp-font-display|body|mono` in runtime.css. */
export const DEFAULT_STACKS = {
  display: ['system-ui', 'sans-serif'],
  body: ['system-ui', 'sans-serif'],
  mono: ['ui-monospace', 'monospace'],
};

/**
 * The brand face for a type role, or a neutral stand-in.
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @param {'display'|'body'|'mono'} role
 * @returns {{family: string, fallbackStack: string[], role: string, embeddable: boolean}}
 */
export function faceFor(brand, role) {
  const faces = (brand && Array.isArray(brand.faces)) ? brand.faces : [];
  const exact = faces.find((f) => f && f.role === role && typeof f.family === 'string' && f.family);
  const chosen = exact
    || (role === 'display' ? faces.find((f) => f && f.role === 'body') : null)
    || (role === 'body' ? faces.find((f) => f && f.role === 'display') : null)
    || null;
  if (!chosen) {
    return { family: DEFAULT_STACKS[role][0], fallbackStack: DEFAULT_STACKS[role].slice(), role, embeddable: false };
  }
  const stack = Array.isArray(chosen.fallbackStack) && chosen.fallbackStack.length
    ? chosen.fallbackStack.slice()
    : [chosen.family, ...DEFAULT_STACKS[role]];
  return { family: chosen.family, fallbackStack: stack, role, embeddable: !!chosen.embeddable };
}

/**
 * CSS generic families: always present, and they resolve to a platform face.
 * The same list L11's `resolveBoxFace` uses; kept here because a layout may not
 * import from the lane that validates it.
 */
const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'math', 'emoji',
]);

/**
 * The families an emitted artifact can count on: any brand face the user
 * supplied a licensed file for, plus the system faces `core/text-metrics.js`
 * holds published metrics for.
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {string[]}
 */
export function availableFamilies(brand) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const add = (name) => {
    const key = normalizeFamily(name);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  };
  for (const face of (brand && brand.faces) || []) if (face && face.embeddable) add(face.family);
  for (const name of FALLBACK_CANDIDATES) add(name);
  return out;
}

/**
 * The family a type role will *actually* be drawn in, once the artifact has
 * substituted whatever the viewer's machine does not have.
 *
 * This exists for `systemMap` and nothing else. Every other layout hands its
 * text to CSS, which breaks lines in whatever face it ended up with — the
 * requested family is the honest thing to report there, and L11 resolves it.
 * SVG has no line breaking, so `systemMap` computes its own breaks; computing
 * them from the metrics of a family the artifact will not use produces lines
 * that fit in the studio and run out of their node on the projector. The
 * substitution has to happen *before* the break, which means here.
 *
 * The rule is L11's (`resolveBoxFace` in src/validate/overflow.js): walk the
 * declared stack — the family the brand asked for, then the fallback stack it
 * declared — and take the first family the artifact can count on; failing that,
 * let `resolveFace` pick the closest available family by metric distance. It is
 * stated twice because L11 depends on L8 and the dependency cannot run both
 * ways; the half that matters, the metric model, is shared in
 * `core/text-metrics.js`. Recorded in docs/decisions/L8-scenes.md.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @param {'display'|'body'|'mono'} role
 * @param {number} [weight]
 * @returns {string}
 */
export function renderedFamily(brand, role, weight = 400) {
  const face = faceFor(brand, role);
  const available = availableFamilies(brand);
  const availKeys = new Set(available.map(normalizeFamily));

  for (const name of [face.family, ...face.fallbackStack]) {
    const key = normalizeFamily(name);
    if (!key) continue;
    if (availKeys.has(key)) return name;
    if (GENERIC_FAMILIES.has(key)) break;   // a generic ends the stack: nothing after it renders
  }
  return resolveFace(face.family, { available, weight }).resolved;
}

/**
 * A colour role's hex, or null. Layouts colour themselves with `var(--pp-*)`
 * rather than with literals — this is for the two places a value has to reach
 * an attribute (an SVG `fill` on a gradient stop, say), and it returns null so
 * the caller falls back to a variable rather than inventing a colour.
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @param {import('../core/contracts.d.ts').ColorRole} role
 * @returns {string|null}
 */
/**
 * The border width the artifact will actually draw with, in px — §7's shape
 * group, or 1 where the brand declares nothing.
 *
 * `scenes.css` writes `var(--pp-border-width)` on the one piece of scene
 * furniture that wears the prospect's shape language and also holds text: the
 * CTA pill. That is two multiples of this number out of the label's inner
 * width, and a measurement that assumed a hairline there would over-report the
 * container on exactly the brands whose buttons are heaviest (CRITIQUE-2 C1).
 * Panels are deliberately drawn with `PANEL_BORDER_PX` instead — see
 * geometry.js — so this is the whole of the brand's influence on a text box.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @returns {number}
 */
export function borderWidthFor(brand) {
  const w = brand && brand.shape ? Number(brand.shape.borderWidthPx) : NaN;
  return Number.isFinite(w) && w >= 0 ? w : 1;
}

export function colorFor(brand, role) {
  const colors = (brand && Array.isArray(brand.colors)) ? brand.colors : [];
  const found = colors.find((c) => c && c.role === role && typeof c.hex === 'string');
  return found ? found.hex : null;
}

/**
 * The brand's primary logo as inline SVG markup, or null.
 *
 * Only `kind: 'svg'` is returned as markup and only when it is markup — a
 * raster logo is a data URI and belongs in an `<img>`, and a logo whose `data`
 * is neither is dropped rather than injected. A layout must never be the path
 * by which unreviewed markup reaches the artifact.
 * @param {import('../core/contracts.d.ts').BrandSystem|null|undefined} brand
 * @param {import('../core/contracts.d.ts').LogoAsset['variant']} [variant]
 * @returns {import('../core/contracts.d.ts').LogoAsset|null}
 */
export function logoFor(brand, variant = 'primary') {
  const logos = (brand && Array.isArray(brand.logos)) ? brand.logos : [];
  return logos.find((l) => l && l.variant === variant) || logos[0] || null;
}

/**
 * A neutral, contract-shaped brand for planning and for previews with nothing
 * extracted yet. Not exported into any artifact: `buildScene` uses it to render
 * a scene once so it can read the element ids the layout actually mints.
 * @returns {import('../core/contracts.d.ts').BrandSystem}
 */
export function neutralBrand() {
  return {
    id: 'br_neutral',
    sourceUrl: null,
    capturedAt: '1970-01-01T00:00:00.000Z',
    colors: [],
    faces: [
      { family: DEFAULT_STACKS.display[0], fallbackStack: DEFAULT_STACKS.display.slice(), weightsSeen: [400, 700], role: 'display', metricDelta: null, embeddable: false },
      { family: DEFAULT_STACKS.body[0], fallbackStack: DEFAULT_STACKS.body.slice(), weightsSeen: [400, 600], role: 'body', metricDelta: null, embeddable: false },
      { family: DEFAULT_STACKS.mono[0], fallbackStack: DEFAULT_STACKS.mono.slice(), weightsSeen: [400], role: 'mono', metricDelta: null, embeddable: false },
    ],
    logos: [],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 0 },
    imagery: { treatment: 'unknown', saturationBias: 0 },
    confidence: { colors: 0, faces: 0, logos: 0, shape: 0, imagery: 0 },
    manualOverrides: [],
  };
}
