/**
 * The L5 lane surface (API.md Part 3) and the artifact theme compiler.
 *
 * Two jobs:
 *
 *  1. `buildBrandSystem` assembles a contract-valid §4 `BrandSystem` out of
 *     whatever the studio has — finished parts from L4's colour solve, or raw
 *     captured document/stylesheet/asset/pixel inputs this lane extracts from
 *     itself. It validates the result with `core/contracts.js` `validateBrand`
 *     and throws rather than returning something the emitter would choke on.
 *
 *  2. `compileTheme` turns that brand into the artifact's CSS custom properties.
 *     **`--pp-*` only** (DECISIONS D11, §15). Studio chrome is `--st-*` and the
 *     two namespaces never meet; `assertNoStudioVars` makes that a throw rather
 *     than a convention, and `test/brand/theme.test.mjs` asserts it on the
 *     emitted string.
 *
 * The variable list is taken from `src/runtime/runtime.css` — every custom
 * property the artifact stylesheet reads is emitted here, so a themed artifact
 * never falls back to a neutral default it did not ask for.
 *
 * @module brand/theme
 */

import { validateBrand, COLOR_ROLES, MAX_TRANSITION_MS } from '../core/contracts.js';
import { contentId } from '../core/ids.js';
import { cssFontFamily, FALLBACK_CANDIDATES } from '../core/text-metrics.js';

import { detectFaces, facesConfidence } from './type.js';
import { extractLogos, inverseVariant, logosConfidence } from './logo.js';
import { collectShapeEvidence, shapeFromEvidence, shapeConfidence } from './shape.js';
import { classifyImagery, sampleFromPng } from './imagery.js';
import { sniffFormat } from './logo.js';

export { detectFaces, attachUserFont, facesConfidence } from './type.js';
export { extractLogos, inverseVariant, logosConfidence, selectLogos, identityScore, declaredLogoUrls } from './logo.js';
export { detectShape, shapeConfidence } from './shape.js';
export { classifyImagery, sampleFromPng, classifyImage, normalizeSample } from './imagery.js';

// ------------------------------------------------------------- theme tables

/**
 * Every `ColorRole` in §4, mapped to the custom property the artifact
 * stylesheet reads. The map is exhaustive by construction: `compileTheme`
 * asserts that every entry in `COLOR_ROLES` appears here.
 */
export const ROLE_VAR = {
  primary: '--pp-primary',
  onPrimary: '--pp-on-primary',
  secondary: '--pp-secondary',
  onSecondary: '--pp-on-secondary',
  surface: '--pp-surface',
  onSurface: '--pp-on-surface',
  surfaceAlt: '--pp-surface-alt',
  onSurfaceAlt: '--pp-on-surface-alt',
  accent: '--pp-accent',
  onAccent: '--pp-on-accent',
  border: '--pp-border',
  success: '--pp-success',
  warning: '--pp-warning',
  danger: '--pp-danger',
};

/** The three type roles, mapped to their custom properties. */
export const FACE_VAR = { display: '--pp-font-display', body: '--pp-font-body', mono: '--pp-font-mono' };

/**
 * The order variables are written in. Fixed rather than derived, so the emitted
 * CSS is byte-identical across runs (§5) and readable in a diff.
 */
export const VAR_ORDER = [
  '--pp-primary', '--pp-on-primary',
  '--pp-secondary', '--pp-on-secondary',
  '--pp-surface', '--pp-on-surface',
  '--pp-surface-alt', '--pp-on-surface-alt',
  '--pp-accent', '--pp-on-accent',
  '--pp-border',
  '--pp-success', '--pp-warning', '--pp-danger',
  '--pp-font-display', '--pp-font-body', '--pp-font-mono',
  '--pp-radius', '--pp-border-width', '--pp-shadow',
  '--pp-transition-ms', '--pp-stage-pad', '--pp-scale',
];

/**
 * The neutral values `src/runtime/runtime.css` ships. A brand that did not
 * produce a value for a property gets the same value the stylesheet would have
 * used, written explicitly — so the compiled theme is a complete description of
 * the artifact's appearance rather than a partial override.
 */
export const THEME_DEFAULTS = {
  '--pp-primary': '#1a1a1a',
  '--pp-on-primary': '#ffffff',
  '--pp-secondary': '#4a4a4a',
  '--pp-on-secondary': '#ffffff',
  '--pp-surface': '#ffffff',
  '--pp-on-surface': '#16181d',
  '--pp-surface-alt': '#f4f5f7',
  '--pp-on-surface-alt': '#16181d',
  '--pp-accent': '#2f5bd8',
  '--pp-on-accent': '#ffffff',
  '--pp-border': '#d9dce1',
  '--pp-success': '#17693f',
  '--pp-warning': '#8a5a00',
  '--pp-danger': '#a32020',
  '--pp-font-display': 'system-ui, sans-serif',
  '--pp-font-body': 'system-ui, sans-serif',
  '--pp-font-mono': 'ui-monospace, monospace',
  '--pp-radius': '8px',
  '--pp-border-width': '1px',
  '--pp-shadow': 'none',
  '--pp-transition-ms': '200ms',
  '--pp-stage-pad': 'clamp(20px, 3.2vw, 56px)',
  '--pp-scale': '1',
};

/**
 * The shadow each detected tier compiles to.
 *
 * The tiers are detected against Material Design's published elevations (see
 * `shape.js` `SHADOW_TIER_BOUNDS`), so they compile back onto the same ladder:
 * tier 1 is a dp1-class hairline lift, tier 2 a dp4-class card, tier 3 a
 * dp16-class modal.
 *
 * The shadow colour is a fixed near-black rather than a brand colour. A shadow
 * tinted with the brand's ink turns into a coloured haze on any surface that is
 * not white, and a proof that looks hazy in a client meeting is a defect the
 * brand did not ask for.
 */
export const SHADOW_SCALE = {
  0: 'none',
  1: '0 1px 2px rgba(12, 15, 20, 0.08), 0 1px 3px rgba(12, 15, 20, 0.06)',
  2: '0 2px 4px rgba(12, 15, 20, 0.08), 0 8px 16px rgba(12, 15, 20, 0.10)',
  3: '0 4px 8px rgba(12, 15, 20, 0.10), 0 20px 40px rgba(12, 15, 20, 0.16)',
};

/**
 * The transition duration the artifact animates at. §10 caps every transition
 * at 240ms; 200ms is `runtime.css`'s own value and sits inside the cap.
 */
export const TRANSITION_MS = Math.min(200, MAX_TRANSITION_MS);

/** The prefix no artifact stylesheet may ever contain (D11). */
export const STUDIO_PREFIX = '--st-';

// -------------------------------------------------------------- theme compile

/**
 * Throw if a compiled artifact stylesheet mentions the studio's namespace.
 * §15 calls a single shared variable between studio chrome and artifact output
 * a bug; this is where that becomes a failure rather than a code review.
 * @param {string} css
 * @returns {string}
 */
export function assertNoStudioVars(css) {
  const text = String(css || '');
  if (text.includes(STUDIO_PREFIX)) {
    throw new Error(`compileTheme: the artifact theme must never contain a "${STUDIO_PREFIX}" variable (DECISIONS D11)`);
  }
  return text;
}

/**
 * Choose the face that will carry a role.
 *
 * Faces are ranked by confidence, then by how much evidence there was, then by
 * name — never by array order, so two extractions that found the same faces
 * compile to the same theme. A role with no face falls back: `display` borrows
 * the body face rather than dropping to a system font, because a headline in a
 * different family than the body copy is a visible defect while a headline in
 * the body face is merely quiet. `body` and `mono` fall back to the stylesheet
 * defaults.
 *
 * @param {any[]} faces
 * @param {'display'|'body'|'mono'} role
 * @returns {any|null}
 */
export function pickFace(faces, role) {
  const list = (faces || []).filter((f) => f && f.role === role);
  list.sort((a, b) =>
    ((b.confidence ?? 0) - (a.confidence ?? 0))
    || ((b.evidence?.occurrences ?? 0) - (a.evidence?.occurrences ?? 0))
    || String(a.family).localeCompare(String(b.family)));
  if (list.length > 0) return list[0];
  if (role === 'display') return pickFace(faces, 'body');
  return null;
}

/**
 * @typedef {object} CompiledTheme
 * @property {string} css                  a `:root` block, plus `@font-face` for any embeddable face
 * @property {Record<string, string>} vars  every `--pp-*` property, by name
 * @property {string[]} fontFaces          the families the theme embeds, if any
 */

/**
 * Compile a §4 `BrandSystem` into the artifact's custom properties (§7, §15).
 *
 * @param {any} brand
 * @returns {CompiledTheme}
 */
export function compileTheme(brand) {
  const b = brand || {};
  for (const role of COLOR_ROLES) {
    if (!ROLE_VAR[role]) throw new Error(`compileTheme: no --pp-* variable is mapped for ColorRole "${role}"`);
  }

  /** @type {Record<string, string>} */
  const vars = { ...THEME_DEFAULTS };

  // --- colours -----------------------------------------------------------
  // Later tokens for the same role win, which is what a manual override is.
  for (const token of Array.isArray(b.colors) ? b.colors : []) {
    if (!token || !ROLE_VAR[token.role]) continue;
    if (typeof token.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(token.hex)) continue;
    vars[ROLE_VAR[token.role]] = token.hex.toLowerCase();
  }

  // --- type --------------------------------------------------------------
  const faces = Array.isArray(b.faces) ? b.faces : [];
  /** @type {string[]} */
  const fontFaces = [];
  /** @type {string[]} */
  const fontFaceRules = [];
  for (const role of /** @type {const} */ (['display', 'body', 'mono'])) {
    const face = pickFace(faces, role);
    if (!face) continue;
    const stack = Array.isArray(face.fallbackStack) && face.fallbackStack.length
      ? face.fallbackStack
      : [face.family];
    vars[FACE_VAR[role]] = cssFontFamily(stack);
  }
  // A face the user supplied a licensed file for is embedded; nothing else ever
  // is (§7, §18). The `src` is a `data:` URI, so the artifact still makes no
  // network request.
  for (const face of faces) {
    if (!face || face.embeddable !== true) continue;
    const file = face.fontFile;
    if (!file || typeof file.dataUri !== 'string' || !file.dataUri.startsWith('data:')) continue;
    if (fontFaces.includes(face.family)) continue;
    fontFaces.push(face.family);
    const weights = Array.isArray(face.weightsSeen) && face.weightsSeen.length ? face.weightsSeen : [400];
    const weightValue = weights.length > 1 ? `${Math.min(...weights)} ${Math.max(...weights)}` : String(weights[0]);
    fontFaceRules.push([
      '@font-face {',
      `  font-family: "${String(face.family).replace(/"/g, '')}";`,
      `  font-style: ${file.style === 'italic' ? 'italic' : 'normal'};`,
      `  font-weight: ${weightValue};`,
      '  font-display: block;',
      `  src: url("${file.dataUri}");`,
      '}',
    ].join('\n'));
  }

  // --- shape -------------------------------------------------------------
  const shape = b.shape && typeof b.shape === 'object' ? b.shape : null;
  if (shape) {
    if (Number.isFinite(shape.radiusPx)) vars['--pp-radius'] = `${trimNumber(shape.radiusPx)}px`;
    if (Number.isFinite(shape.borderWidthPx)) vars['--pp-border-width'] = `${trimNumber(shape.borderWidthPx)}px`;
    const level = [0, 1, 2, 3].includes(shape.shadowLevel) ? shape.shadowLevel : 0;
    vars['--pp-shadow'] = SHADOW_SCALE[level];
  }

  // --- runtime-owned properties -----------------------------------------
  vars['--pp-transition-ms'] = `${TRANSITION_MS}ms`;

  const declarations = VAR_ORDER.map((name) => `  ${name}: ${vars[name]};`).join('\n');
  const css = [
    '/* PitchProof artifact theme */',
    ...fontFaceRules,
    ':root {',
    declarations,
    '}',
    '',
  ].join('\n');

  return { css: assertNoStudioVars(css), vars, fontFaces };
}

/** @param {number} n @returns {string} */
function trimNumber(n) {
  const rounded = Math.round(n * 1000) / 1000;
  return String(rounded);
}

// ---------------------------------------------------------- brand assembly

/**
 * @typedef {object} BrandParts
 * @property {string|null} [sourceUrl]
 * @property {any[]} [colors]        §4 ColorTokens, from L4's `solveRoles`
 * @property {any[]} [faces]         already-detected faces; otherwise detected here
 * @property {any[]} [logos]         already-extracted logos; otherwise extracted here
 * @property {{radiusPx: number, borderWidthPx: number, shadowLevel: number}} [shape]
 * @property {{treatment: string, saturationBias: number}} [imagery]
 * @property {any} [doc]             an L3 DocNode tree
 * @property {string|string[]|object[]} [css]
 * @property {{name?: string, bytes?: Uint8Array, mime?: string}[]} [assets]
 * @property {any[]} [images]        `ImageSample[]` for the imagery classifier
 * @property {string[]} [available]  families guaranteed to render in the artifact
 * @property {Partial<Record<'colors'|'faces'|'logos'|'shape'|'imagery', number>>} [confidence]
 * @property {string[]} [manualOverrides]
 * @property {boolean} [generateInverse]   default true
 */

/**
 * Assemble a §4 `BrandSystem`.
 *
 * Every part may be supplied finished or extracted here from raw inputs, which
 * is what lets the studio mix an automatic extraction with hand-entered fields
 * without a second code path. Colour is L4's: if `parts.colors` is absent this
 * returns an empty palette and a colour confidence of zero rather than
 * inventing one, because §7's role assignment is a solve that belongs to the
 * lane that owns it.
 *
 * `capturedAt` comes from the injected clock and every id from the injected
 * minter or a content hash — no wall clock, no `Math.random` (§5).
 *
 * @param {BrandParts} parts
 * @param {{clock: () => string, idMinter: {next: (kind: string) => string}}} deps
 * @returns {any}   a §4 BrandSystem
 */
export function buildBrandSystem(parts, deps) {
  const p = parts || {};
  if (!deps || typeof deps.clock !== 'function') throw new Error('buildBrandSystem: an injected clock is required (§5)');
  if (!deps.idMinter || typeof deps.idMinter.next !== 'function') throw new Error('buildBrandSystem: an injected idMinter is required (§5)');

  const available = p.available || FALLBACK_CANDIDATES;

  // --- faces -------------------------------------------------------------
  const faces = Array.isArray(p.faces)
    ? p.faces.map(normalizeFace)
    : (p.doc || p.css ? detectFaces(p.doc || null, p.css || '', { available }).map(normalizeFace) : []);

  // --- logos -------------------------------------------------------------
  let logos = Array.isArray(p.logos)
    ? p.logos.slice()
    : (p.doc || p.assets ? extractLogos(p.doc || null, p.assets || [], { idMinter: deps.idMinter }) : []);

  if (p.generateInverse !== false) {
    const haveInverse = logos.some((l) => l && l.variant === 'inverse');
    if (!haveInverse) {
      for (const logo of logos.slice()) {
        const inverse = inverseVariant(logo);
        if (inverse) { logos = logos.concat([inverse]); break; }
      }
    }
  }
  logos = logos.map(normalizeLogo);

  // --- shape -------------------------------------------------------------
  const shapeEvidence = p.shape ? null : collectShapeEvidence(joinCss(p.css));
  const shape = p.shape
    ? {
      radiusPx: Number(p.shape.radiusPx) || 0,
      borderWidthPx: Number(p.shape.borderWidthPx) || 0,
      shadowLevel: [0, 1, 2, 3].includes(p.shape.shadowLevel) ? p.shape.shadowLevel : 0,
    }
    : shapeFromEvidence(shapeEvidence);

  // --- imagery -----------------------------------------------------------
  const imageryResult = p.imagery ? null : classifyImagery(toImageSamples(p.images));
  const imagery = p.imagery
    ? {
      treatment: ['photographic', 'illustrative', 'mixed', 'unknown'].includes(p.imagery.treatment) ? p.imagery.treatment : 'unknown',
      saturationBias: Number.isFinite(p.imagery.saturationBias) ? p.imagery.saturationBias : 0,
    }
    : { treatment: imageryResult.treatment, saturationBias: imageryResult.saturationBias };

  // --- colours -----------------------------------------------------------
  const colors = Array.isArray(p.colors) ? p.colors.map(normalizeColor).filter(Boolean) : [];

  // --- confidence --------------------------------------------------------
  const supplied = p.confidence || {};
  const confidence = {
    colors: clamp01(numberOr(supplied.colors, 0)),
    faces: clamp01(numberOr(supplied.faces, facesConfidence(faces))),
    logos: clamp01(numberOr(supplied.logos, logosConfidence(logos))),
    shape: clamp01(numberOr(supplied.shape, shapeEvidence ? shapeConfidence(shapeEvidence) : (p.shape ? 1 : 0))),
    imagery: clamp01(numberOr(supplied.imagery, imageryResult ? imageryResult.confidence : (p.imagery ? 1 : 0))),
  };

  const sourceUrl = typeof p.sourceUrl === 'string' ? p.sourceUrl : null;
  const manualOverrides = Array.isArray(p.manualOverrides) ? p.manualOverrides.filter((s) => typeof s === 'string') : [];

  const brand = {
    // Content-derived so that rebuilding the same brand yields the same id, on
    // any machine, in any order (§5). The clock is deliberately excluded: a
    // recapture that found the same brand is the same brand.
    id: contentId('brand', { sourceUrl, colors, faces, logos, shape, imagery }),
    sourceUrl,
    capturedAt: deps.clock(),
    colors,
    faces,
    logos,
    shape,
    imagery,
    confidence,
    manualOverrides,
  };

  /** @type {string[]} */
  const errors = [];
  validateBrand(brand, 'brand', errors);
  if (errors.length) {
    throw new Error(`buildBrandSystem: produced an invalid BrandSystem:\n  ${errors.join('\n  ')}`);
  }
  return brand;
}

/**
 * Coerce a face into the §4 shape without discarding this lane's optional
 * extensions, so a hand-entered face and a detected one are the same object.
 * @param {any} face
 * @returns {any}
 */
export function normalizeFace(face) {
  const f = face || {};
  const weights = Array.isArray(f.weightsSeen) ? f.weightsSeen.filter((n) => Number.isFinite(n)) : [];
  const stack = Array.isArray(f.fallbackStack) ? f.fallbackStack.filter((s) => typeof s === 'string') : [];
  const delta = f.metricDelta && Number.isFinite(f.metricDelta.capHeight)
    && Number.isFinite(f.metricDelta.xHeight) && Number.isFinite(f.metricDelta.avgAdvance)
    ? { capHeight: f.metricDelta.capHeight, xHeight: f.metricDelta.xHeight, avgAdvance: f.metricDelta.avgAdvance }
    : null;
  return {
    ...f,
    family: String(f.family || ''),
    fallbackStack: stack.length ? stack : [String(f.family || 'sans-serif')],
    weightsSeen: weights.length ? weights : [400],
    role: ['display', 'body', 'mono'].includes(f.role) ? f.role : 'body',
    metricDelta: delta,
    embeddable: f.embeddable === true,
  };
}

/**
 * Coerce a logo into the §4 shape.
 * @param {any} logo
 * @returns {any}
 */
export function normalizeLogo(logo) {
  const l = logo || {};
  return {
    ...l,
    id: String(l.id || ''),
    kind: l.kind === 'svg' ? 'svg' : 'raster',
    data: String(l.data || ''),
    variant: ['primary', 'mark', 'wordmark', 'inverse', 'favicon'].includes(l.variant) ? l.variant : 'primary',
    intrinsic: {
      w: Number.isFinite(l.intrinsic?.w) ? l.intrinsic.w : 0,
      h: Number.isFinite(l.intrinsic?.h) ? l.intrinsic.h : 0,
    },
    hasTransparency: l.hasTransparency === true,
  };
}

/**
 * Keep only colour tokens that satisfy §4. A malformed token from anywhere is
 * dropped rather than carried into an artifact, where it would render as an
 * invalid custom property and take a whole scene's palette with it.
 * @param {any} token
 * @returns {any|null}
 */
export function normalizeColor(token) {
  const t = token || {};
  if (!COLOR_ROLES.includes(t.role)) return null;
  if (typeof t.hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(t.hex)) return null;
  const oklch = Array.isArray(t.oklch) && t.oklch.length === 3 && t.oklch.every((n) => Number.isFinite(n))
    ? [t.oklch[0], t.oklch[1], t.oklch[2]]
    : null;
  if (!oklch) return null;
  if (!['extracted', 'derived', 'manual'].includes(t.source)) return null;
  return {
    ...t,
    role: t.role,
    hex: t.hex.toLowerCase(),
    oklch,
    source: t.source,
    contrastWithPair: Number.isFinite(t.contrastWithPair) ? t.contrastWithPair : null,
  };
}

/**
 * Accept either decoded `ImageSample`s or the raw `{name, bytes, mime}` asset
 * records L3's ingest produces, so a caller that has bytes does not have to know
 * which of them this build can decode.
 *
 * Entries already carrying pixel `data` pass through untouched. Entries carrying
 * `bytes` are decoded when they are PNG — the one format this repository decodes
 * (L5-D10) — and skipped otherwise, because a format we cannot read is better
 * left out of the evidence than guessed at. A caller with JPEG pixels decodes
 * them with the platform and passes samples.
 *
 * @param {any[]|undefined} images
 * @returns {any[]}
 */
export function toImageSamples(images) {
  if (!Array.isArray(images)) return [];
  /** @type {any[]} */
  const out = [];
  images.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.data && entry.width && entry.height) { out.push(entry); return; }
    const bytes = entry.bytes;
    if (!bytes || typeof bytes.length !== 'number') return;
    if (sniffFormat(bytes) !== 'png') return;
    try {
      out.push(sampleFromPng(bytes, {
        id: typeof entry.id === 'string' ? entry.id : (typeof entry.name === 'string' ? entry.name : `image-${index}`),
        role: entry.role,
        weight: entry.weight,
      }));
    } catch {
      // An undecodable PNG is not evidence; it is also not an error worth
      // failing a whole brand extraction over.
    }
  });
  return out;
}

/**
 * Flatten whatever the caller passed as `css` into one string, for the shape
 * extractor.
 * @param {string|string[]|object[]|undefined} css
 * @returns {string}
 */
export function joinCss(css) {
  if (!css) return '';
  if (typeof css === 'string') return css;
  if (!Array.isArray(css)) return '';
  return css.map((entry) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') return String(entry.text || entry.css || '');
    return '';
  }).join('\n');
}

/** @param {any} value @param {number} fallback @returns {number} */
function numberOr(value, fallback) { return Number.isFinite(value) ? value : fallback; }
/** @param {number} n @returns {number} */
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
