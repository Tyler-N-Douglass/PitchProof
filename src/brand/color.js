/**
 * L4 Brand colour — the public surface declared in `API.md` Part 3.
 *
 * Everything §7 asks of colour lives under `src/brand/` and is republished
 * here:
 *
 *   `oklab.js`       exact sRGB ↔ linear ↔ OKLab ↔ OKLCH, WCAG 2.1 luminance
 *                    and contrast, gamut testing and chroma clamping
 *   `color-css.js`   CSS colour syntax and stylesheet declaration scanning
 *   `cluster.js`     collection, the area model, seeded k-means in OKLab,
 *                    silhouette k-selection
 *   `roles.js`       role assignment as a constrained optimisation
 *   `derive.js`      lightness walking in OKLCH to meet a contrast constraint
 *   `confidence.js`  computed confidence from separation, size and agreement
 *
 * @module brand/color
 */

export {
  srgbToLinear, linearToSrgb, hexToRgb, rgbToHex, hexAlpha, rgbInRange,
  rgbToOklab, oklabToRgb, linearRgbToOklab, oklabToLinearRgb,
  xyzToOklab, oklabToXyz,
  oklabToOklch, oklchToOklab, hexToOklch, oklchToHex, hexToOklab, oklabToHex,
  relativeLuminance, luminanceOfHex, contrastFromLuminance, contrastRatio, contrastRatioRgb,
  inGamut, clampChromaToGamut, maxChromaAt,
  deltaEok, hueDistance, meanHue,
  SRGB_LINEAR_BREAK, SRGB_LINEAR_BREAK_LINEAR, SRGB_SLOPE, SRGB_OFFSET, SRGB_GAMMA,
  WCAG_LINEAR_BREAK, WCAG_CONTRAST_OFFSET, LUMA_R, LUMA_G, LUMA_B,
  MAX_CONTRAST, GUARANTEED_CONTRAST, GAMUT_EPS_8BIT, MAX_SRGB_CHROMA_BOUND,
  ACHROMATIC_EPS, SRGB_HUES,
} from './oklab.js';

export {
  NAMED_COLORS, parseCssColor, hslToRgb, hwbToRgb, compositeOver,
  colorTokensIn, scanCssDeclarations, stripCssComments, UNRESOLVABLE_KEYWORDS,
} from './color-css.js';

export {
  quantize, chooseK, kmeansOklab, kmeansPlusPlusSeeds, silhouetteScore,
  collectColors, collectFromComputedStyles, collectFromCss, collectFromPixels,
  normalizeSampleWeights, decodePixels, toSamples, textInkArea,
  SOURCE_WEIGHTS, INK_DUTY_CYCLE, REFERENCE_VIEWPORT_AREA, ASSUMED_CARD_FRACTION,
  ASSUMED_BORDER_PX, ASSUMED_FONT_SIZE_PX, ASSUMED_LINE_HEIGHT,
  ASSUMED_TEXT_CHARS, ASSUMED_TEXT_LINES, HELVETICA_STD_VW,
  KMEANS_STREAM, KMEANS_RESTARTS, MAX_KMEANS_ITERS, SILHOUETTE_MAX_POINTS,
  SILHOUETTE_TIE_EPS, MAX_PIXEL_SAMPLES,
} from './cluster.js';

export {
  solveRoles, ContrastSolveError, buildCandidatePool, buildContext,
  searchAssignment, unaryCost, binaryCost, variantCandidates, hueCusp, cuspChroma,
  paletteContrastReport, assertPaletteContrast,
  BACKGROUND_SLOTS, CHROMA_BANDS, CHROMA_EXCESS_CAP, ROLE_COST_WEIGHTS,
  COMFORT_TARGET, AREA_IMPORTANCE, ELEVATION_BAND, MIN_PRIMARY_ACCENT_HUE,
  DUPLICATE_DELTA_E, POOL_CAP, MAX_VARIANT_SEEDS, DERIVE_MARGIN,
  SEMANTIC_HUES, SEMANTIC_HUE_TOLERANCE, SEMANTIC_CHROMA_FRACTION,
  SEMANTIC_MIN_CHROMA_FRACTION, ANCHOR_TINT_FRACTION, BORDER_CHROMA_WEIGHT,
} from './roles.js';

export {
  deriveForContrast, DeriveError, contrastCeiling, bestExtremeFor, normalizeHex,
  contrastReachable, neutralAnchors, DERIVE_STREAM, DERIVE_L_STEPS,
  DERIVE_BISECT_ITERS, LIGHT_ANCHOR_MAX_CONTRAST, DARK_ANCHOR_MAX_CONTRAST,
} from './derive.js';

export {
  colorConfidence, colorConfidenceDetail, clusterSeparation, sampleSizeFactor,
  sourceAgreement, totalSamples, normalizeSources,
  CONFIDENCE_WEIGHTS, UNKNOWN_FACTOR, HALF_CONFIDENCE_SAMPLES,
} from './confidence.js';

import { collectColors as collect } from './cluster.js';
import { quantize as quantizeSamples, chooseK as pickK } from './cluster.js';
import { solveRoles as solve } from './roles.js';
import { colorConfidence as confidenceOf } from './confidence.js';
import { CONTRAST_AA_BODY } from '../core/contracts.js';

/**
 * The whole §7 colour pipeline in one call, for L5's `buildBrandSystem` and for
 * the studio's extract step: collect from every available source, cluster in
 * OKLab with k chosen by silhouette, solve the roles, and compute confidence.
 *
 * @param {{
 *   computed?: any[], css?: string|string[], images?: any[], logos?: any[],
 *   backdrop?: readonly number[]
 * }} sources
 * @param {{seed?: any, k?: number, range?: [number, number], minRatio?: number}} [options]
 * @returns {{
 *   colors: import('../core/contracts.d.ts').ColorToken[],
 *   clusters: import('./cluster.js').Cluster[],
 *   confidence: number, k: number, sampleCount: number, origins: string[]
 * }}
 */
export function extractPalette(sources, options = {}) {
  const { samples, origins } = collect(sources || {});
  if (samples.length === 0) {
    throw new Error('extractPalette: no colours could be collected from any source');
  }
  const k = Number.isFinite(options.k) && options.k > 0
    ? Math.floor(options.k)
    : pickK(samples, { seed: options.seed, range: options.range });
  const clusters = quantizeSamples(samples, { k, seed: options.seed });
  const colors = solve(clusters, {
    seed: options.seed,
    minRatio: Number.isFinite(options.minRatio) ? options.minRatio : CONTRAST_AA_BODY,
  });
  return {
    colors,
    clusters,
    confidence: confidenceOf(clusters, origins),
    k: clusters.length,
    sampleCount: samples.length,
    origins,
  };
}
