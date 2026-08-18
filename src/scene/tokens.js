/**
 * The scene design tokens — the single source of truth for every number that
 * appears both in `src/scene/scenes.css` and in `measureScene`.
 *
 * §22.2 makes post-substitution text overflow the defect that matters most, and
 * a detector is only as good as the container dimensions it is handed. So the
 * geometry a layout is drawn with and the geometry it is measured with are not
 * allowed to be two lists that someone keeps in sync by hand: they are this
 * one table. `scenes.css` declares these values as `--pp-sc-*` custom properties
 * — one `:root` block per breakpoint — and
 * `test/scene/css-agreement.test.mjs` parses the stylesheet and asserts it
 * declares exactly `sceneVars(bp)`, value for value. A number changed in one
 * place and not the other fails the build.
 *
 * Variables are `--pp-*` only (D11). The studio chrome's own variable namespace
 * may not appear anywhere under `src/scene`, and
 * `test/scene/css-agreement.test.mjs` asserts its absence.
 *
 * @module scene/tokens
 */

/** The three breakpoint ids from `BREAKPOINTS` in core/contracts.js. */
export const BP_IDS = ['sm', 'md', 'lg'];

/**
 * The CSS media query each breakpoint is selected by, in `scenes.css`. `sm` is
 * the unqualified base block, so it has no query.
 * @type {Record<string, string|null>}
 */
export const BP_QUERY = {
  sm: null,
  md: '(min-width: 768px)',
  lg: '(min-width: 1400px)',
};

/**
 * Geometry tokens, per breakpoint.
 *
 * Lengths are px unless the name ends in a unit-bearing suffix; a few are
 * percentage or `auto`-like strings because the CSS uses them in a grid track,
 * and those are carried verbatim. Unitless counts (`fan-cols`) are numbers.
 *
 * The vertical model every layout shares:
 *
 *     contentHeight = viewportHeight - 2 * stagePad        (runtime.css)
 *     bodyHeight    = contentHeight - headH - headGap      (this table)
 *
 * so every scene's body starts at the same y across the whole deck, which is
 * what makes a sequence of scenes read as one document rather than eight.
 */
export const GEOM = {
  sm: {
    'head-h': 84,
    'head-gap': 16,
    'panel-pad': 14,
    'panel-head-h': 34,
    'row-gap': 10,
    'list-marker-w': 14,
    'cell-pad': 6,
    'split-gap': 16,
    'fan-gap': 12,
    'fan-card-min-h': 140,
    'fan-cols': 2,
    'fan-source-w': '100%',
    'fan-source-h': 140,
    'fan-source-gap': 16,
    'card-pad': 10,
    'stack-rail-w': 28,
    'stack-rail-gap': 12,
    'stack-step-gap': 10,
    'step-pad': 12,
    'bleed-max-w': 350,
    'bleed-pad': 16,
    'note-w': '100%',
    'note-gap': 12,
    'note-pad': 12,
    'quote-max-w': 350,
    'quote-pad': 16,
    'index-num-w': 32,
    'index-gap': 12,
    'index-row-gap': 10,
    'map-legend-h': 120,
    'map-legend-cols': 1,
    'map-canvas-min-h': 180,
  },
  md: {
    'head-h': 104,
    'head-gap': 24,
    'panel-pad': 18,
    'panel-head-h': 40,
    'row-gap': 12,
    'list-marker-w': 16,
    'cell-pad': 8,
    'split-gap': 24,
    'fan-gap': 18,
    'fan-card-min-h': 150,
    'fan-cols': 3,
    'fan-source-w': 280,
    'fan-source-h': 140,
    'fan-source-gap': 24,
    'card-pad': 12,
    'stack-rail-w': 36,
    'stack-rail-gap': 16,
    'stack-step-gap': 12,
    'step-pad': 16,
    'bleed-max-w': 640,
    'bleed-pad': 22,
    'note-w': 260,
    'note-gap': 24,
    'note-pad': 14,
    'quote-max-w': 760,
    'quote-pad': 28,
    'index-num-w': 44,
    'index-gap': 14,
    'index-row-gap': 12,
    'map-legend-h': 104,
    'map-legend-cols': 3,
    'map-canvas-min-h': 240,
  },
  lg: {
    'head-h': 120,
    'head-gap': 28,
    'panel-pad': 22,
    'panel-head-h': 46,
    'row-gap': 14,
    'list-marker-w': 18,
    'cell-pad': 9,
    'split-gap': 32,
    'fan-gap': 24,
    'fan-card-min-h': 160,
    'fan-cols': 4,
    'fan-source-w': 360,
    'fan-source-h': 140,
    'fan-source-gap': 32,
    'card-pad': 14,
    'stack-rail-w': 40,
    'stack-rail-gap': 20,
    'stack-step-gap': 16,
    'step-pad': 18,
    'bleed-max-w': 820,
    'bleed-pad': 28,
    'note-w': 320,
    'note-gap': 32,
    'note-pad': 16,
    'quote-max-w': 980,
    'quote-pad': 36,
    'index-num-w': 52,
    'index-gap': 16,
    'index-row-gap': 14,
    'map-legend-h': 104,
    'map-legend-cols': 5,
    'map-canvas-min-h': 280,
  },
};

/** Tokens whose value is a bare number in CSS rather than a length. */
export const UNITLESS_TOKENS = new Set(['fan-cols', 'map-legend-cols']);

/**
 * The type scale.
 *
 * One entry per *text role*. A role is stamped on the element as
 * `data-pp-tx="<role>"`, `scenes.css` styles that attribute, and `measureScene`
 * reads the same attribute back. There is exactly one path from a rendered run
 * of text to the style that will apply to it, which is the only way the
 * measurement can be trusted.
 *
 * `face` names which of the brand's three faces applies — the CSS says
 * `var(--pp-font-display|body|mono)` and the measurement resolves the brand's
 * `TypeFace` of that role, so the two agree by construction even when the
 * prospect's type system is nothing like the default.
 *
 * `definedIn: 'runtime.css'` marks a role whose type is set by L2's stylesheet
 * rather than ours — `provenance` is the only one, because §18.1 makes its size
 * and contrast a law the emitter checks, and a second declaration here would be
 * a second place for that law to drift.
 *
 * @typedef {object} TypeRole
 * @property {'display'|'body'|'mono'} face
 * @property {{sm: number, md: number, lg: number}} sizes   font-size, CSS px
 * @property {number} lineHeight        unitless
 * @property {number} weight
 * @property {number} [letterSpacingEm] em, converted to px at measure time
 * @property {'none'|'uppercase'|'lowercase'|'capitalize'} [textTransform]
 * @property {'scenes.css'|'runtime.css'} [definedIn]
 * @property {boolean} [svg]            sized in SVG design units, scaled to px
 */

/** @type {Record<string, TypeRole>} */
export const TYPE_ROLES = {
  kicker: { face: 'body', sizes: { sm: 10, md: 11, lg: 12 }, lineHeight: 1.2, weight: 600, letterSpacingEm: 0.08, textTransform: 'uppercase' },
  headline: { face: 'display', sizes: { sm: 22, md: 30, lg: 38 }, lineHeight: 1.15, weight: 700, letterSpacingEm: -0.01 },
  subhead: { face: 'body', sizes: { sm: 14, md: 17, lg: 20 }, lineHeight: 1.35, weight: 400 },

  panelTitle: { face: 'display', sizes: { sm: 13, md: 15, lg: 17 }, lineHeight: 1.25, weight: 600 },
  panelMeta: { face: 'mono', sizes: { sm: 10, md: 11, lg: 12 }, lineHeight: 1.3, weight: 400, letterSpacingEm: 0.01 },

  bh1: { face: 'display', sizes: { sm: 18, md: 22, lg: 26 }, lineHeight: 1.2, weight: 700 },
  bh2: { face: 'display', sizes: { sm: 15, md: 18, lg: 21 }, lineHeight: 1.25, weight: 700 },
  bh3: { face: 'display', sizes: { sm: 13, md: 15, lg: 17 }, lineHeight: 1.3, weight: 600 },
  body: { face: 'body', sizes: { sm: 12, md: 14, lg: 16 }, lineHeight: 1.5, weight: 400 },
  listItem: { face: 'body', sizes: { sm: 12, md: 14, lg: 16 }, lineHeight: 1.45, weight: 400 },
  quote: { face: 'display', sizes: { sm: 20, md: 28, lg: 34 }, lineHeight: 1.3, weight: 500, letterSpacingEm: -0.01 },
  attribution: { face: 'body', sizes: { sm: 12, md: 14, lg: 15 }, lineHeight: 1.4, weight: 600 },
  blockQuote: { face: 'display', sizes: { sm: 14, md: 17, lg: 20 }, lineHeight: 1.4, weight: 500 },
  blockAttribution: { face: 'body', sizes: { sm: 10, md: 12, lg: 13 }, lineHeight: 1.3, weight: 600 },
  cellHead: { face: 'body', sizes: { sm: 10, md: 12, lg: 13 }, lineHeight: 1.3, weight: 600, letterSpacingEm: 0.02 },
  cell: { face: 'body', sizes: { sm: 10, md: 12, lg: 13 }, lineHeight: 1.35, weight: 400 },
  cta: { face: 'body', sizes: { sm: 11, md: 13, lg: 14 }, lineHeight: 1.2, weight: 600, letterSpacingEm: 0.01 },
  caption: { face: 'body', sizes: { sm: 10, md: 11, lg: 12 }, lineHeight: 1.35, weight: 400 },

  badgeNumber: { face: 'display', sizes: { sm: 28, md: 40, lg: 52 }, lineHeight: 1, weight: 700, letterSpacingEm: -0.02 },
  badgeLabel: { face: 'body', sizes: { sm: 10, md: 11, lg: 12 }, lineHeight: 1.2, weight: 600, letterSpacingEm: 0.08, textTransform: 'uppercase' },

  stepIndex: { face: 'mono', sizes: { sm: 11, md: 13, lg: 14 }, lineHeight: 1, weight: 700 },
  stepLabel: { face: 'display', sizes: { sm: 13, md: 15, lg: 17 }, lineHeight: 1.25, weight: 600 },

  note: { face: 'body', sizes: { sm: 11, md: 12, lg: 13 }, lineHeight: 1.45, weight: 400 },
  noteLabel: { face: 'body', sizes: { sm: 9, md: 10, lg: 11 }, lineHeight: 1.2, weight: 600, letterSpacingEm: 0.08, textTransform: 'uppercase' },

  indexNumber: { face: 'mono', sizes: { sm: 12, md: 14, lg: 16 }, lineHeight: 1.2, weight: 700 },
  indexTitle: { face: 'display', sizes: { sm: 14, md: 17, lg: 20 }, lineHeight: 1.3, weight: 600 },
  indexBlurb: { face: 'body', sizes: { sm: 11, md: 13, lg: 14 }, lineHeight: 1.45, weight: 400 },

  displayXL: { face: 'display', sizes: { sm: 26, md: 40, lg: 52 }, lineHeight: 1.1, weight: 700, letterSpacingEm: -0.02 },
  displaySub: { face: 'body', sizes: { sm: 13, md: 16, lg: 18 }, lineHeight: 1.4, weight: 400 },

  deco: { face: 'body', sizes: { sm: 11, md: 12, lg: 13 }, lineHeight: 1, weight: 400 },

  // SVG roles are sized in the map's design units and scaled with the drawing.
  mapNodeTitle: { face: 'display', sizes: { sm: 16, md: 16, lg: 16 }, lineHeight: 1.25, weight: 600, svg: true },
  mapNodeMeta: { face: 'mono', sizes: { sm: 12, md: 12, lg: 12 }, lineHeight: 1.25, weight: 400, svg: true },

  // §18.1 — declared by runtime.css, never re-declared here.
  provenance: { face: 'body', sizes: { sm: 12, md: 12, lg: 12 }, lineHeight: 1.35, weight: 600, letterSpacingEm: 0.01, definedIn: 'runtime.css' },
};

/** Roles whose type `scenes.css` is responsible for declaring. */
export function scenesCssRoles() {
  return Object.keys(TYPE_ROLES).filter((r) => (TYPE_ROLES[r].definedIn || 'scenes.css') === 'scenes.css');
}

/**
 * Every `--pp-sc-*` custom property `scenes.css` must declare for a breakpoint,
 * with the exact value it must declare. The stylesheet is checked against this.
 * @param {'sm'|'md'|'lg'} bp
 * @returns {Record<string, string>}
 */
export function sceneVars(bp) {
  /** @type {Record<string, string>} */
  const out = {};
  const g = GEOM[bp];
  for (const key of Object.keys(g).sort()) {
    const v = g[key];
    out[`--pp-sc-${key}`] = UNITLESS_TOKENS.has(key) ? String(v)
      : typeof v === 'number' ? `${v}px` : String(v);
  }
  for (const role of scenesCssRoles().sort()) {
    // SVG roles are sized in the drawing's design units and scale with it, so
    // they carry a literal font-size in the rule rather than a breakpoint
    // variable — there is nothing per-breakpoint about them.
    if (TYPE_ROLES[role].svg) continue;
    out[`--pp-sc-fs-${cssRoleName(role)}`] = `${TYPE_ROLES[role].sizes[bp]}px`;
  }
  return out;
}

/**
 * Role names are camelCase in the model and kebab-case in CSS. One function
 * owns the mapping so the agreement test cannot be fooled by a typo.
 * @param {string} role
 * @returns {string}
 */
export function cssRoleName(role) {
  return role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * A geometry token as a number, for the layouts and the measurement.
 * @param {'sm'|'md'|'lg'} bp
 * @param {string} key
 * @returns {number}
 */
export function geom(bp, key) {
  const v = GEOM[bp][key];
  if (v === undefined) throw new Error(`scene/tokens: no geometry token "${key}"`);
  if (typeof v === 'number') return v;
  const m = /^(-?\d+(?:\.\d+)?)/.exec(String(v));
  return m ? Number(m[1]) : 0;
}

/**
 * True when a token is expressed as a percentage — the stacked-at-`sm` case,
 * where the track is the full content width rather than a fixed rail.
 * @param {'sm'|'md'|'lg'} bp
 * @param {string} key
 * @returns {boolean}
 */
export function isProportional(bp, key) {
  return typeof GEOM[bp][key] === 'string' && String(GEOM[bp][key]).endsWith('%');
}
