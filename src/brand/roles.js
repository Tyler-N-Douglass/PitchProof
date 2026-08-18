/**
 * Role assignment as a constrained optimisation (§7, §22.1, PLAN §4.1).
 *
 * §7: "Role assignment is a solve, not a guess." §22.1 names naive palette
 * swapping as the single most likely way this build fails. So this file does
 * not walk a heuristic chain; it enumerates candidate assignments and scores
 * them with an explicit cost function, then repairs the result until a hard
 * post-condition holds.
 *
 * ## The search
 *
 * Five roles carry a background: `surface`, `surfaceAlt`, `primary`, `accent`,
 * `secondary`. Every other role is a function of those five. The candidate pool
 * is the cluster set plus four synthesised anchors (pure white, pure black, and
 * a near-white and near-black carrying the brand's dominant hue), capped at
 * `POOL_CAP`. The search is an exhaustive depth-first enumeration of the
 * `pool^5` assignments with branch-and-bound pruning: every cost term is
 * non-negative, so the sum of per-slot minima is an admissible lower bound and
 * pruning cannot discard the optimum. With the cap at 14 the worst case is
 * 537,824 leaves; pruning typically visits a few thousand.
 *
 * ## The cost function
 *
 * Seven terms, each normalised to roughly 0..1 and weighted by
 * `ROLE_COST_WEIGHTS`. The weights encode a priority order, and the order is
 * the justification for them:
 *
 *   contrast (3.0)  Readability is the product's binding constraint (§22.1). A
 *                   background whose best possible foreground is weak is a bad
 *                   background even if it is beautiful.
 *   derived  (1.5)  Fidelity. A palette built from the brand's own colours is
 *                   the entire point of the product (§1); a synthesised anchor
 *                   is a concession and is priced as one.
 *   dup      (2.0)  Distinctness. Two roles resolving to the same fill makes
 *                   the theme structurally invisible. Unlike the others this
 *                   term is a sum of collision weights rather than a 0..1
 *                   score, and it is uncapped on purpose.
 *   order    (1.2)  Surface lightness ordering: a page ground belongs at an
 *                   extreme, and the alternate surface steps in from it.
 *   chroma   (1.0)  Role-appropriate colourfulness — "accents want it, surfaces
 *                   don't" (§7).
 *   hue      (0.8)  Primary/accent separation.
 *   area     (0.8)  The area evidence from `cluster.js`.
 *
 * ## The post-condition
 *
 * `solveRoles` returns only palettes in which every `FOREGROUND_ROLES` entry
 * reaches `CONTRAST_AA_BODY` against `ROLE_PAIR[role]`, measured on the
 * quantised `#rrggbb` value. If repair cannot achieve that it throws. It never
 * returns a failing palette.
 *
 * @module brand/roles
 */

import {
  COLOR_ROLES, ROLE_PAIR, FOREGROUND_ROLES, BACKGROUND_ROLES,
  CONTRAST_AA_BODY, CONTRAST_AA_NONTEXT,
} from '../core/contracts.js';
import { SeedBook, DEFAULT_SEED } from '../core/prng.js';
import {
  hexToOklch, oklchToHex, contrastRatio, luminanceOfHex, contrastFromLuminance,
  maxChromaAt, deltaEok, hueDistance, meanHue, oklchToOklab, hexToOklab,
  MAX_CONTRAST, SRGB_HUES, rgbToHex, hexToRgb,
} from './oklab.js';
import {
  deriveForContrast, contrastCeiling, neutralAnchors, normalizeHex,
  DERIVE_STREAM, DeriveError,
} from './derive.js';

/** Thrown when no palette can satisfy the §7 contrast post-condition. */
export class ContrastSolveError extends Error {}

/** The five roles the search assigns; every other role derives from these. */
export const BACKGROUND_SLOTS = ['surface', 'surfaceAlt', 'primary', 'accent', 'secondary'];

/** Foreground roles paired to each background slot. */
const SLOT_FOREGROUND = {
  surface: 'onSurface', surfaceAlt: 'onSurfaceAlt', primary: 'onPrimary',
  accent: 'onAccent', secondary: 'onSecondary',
};

/**
 * Chroma bands per role, expressed as a **fraction of the maximum chroma
 * available in sRGB at that colour's own lightness and hue**. Using a fraction
 * rather than an absolute chroma makes the band meaningful at every lightness:
 * absolute chroma 0.1 is vivid at L = 0.15 and washed out at L = 0.75, but
 * "a third of what is available here" means the same thing everywhere.
 *
 * `max` is an upper bound (surfaces must not be colourful), `min` a lower bound
 * (accents must be).
 */
export const CHROMA_BANDS = {
  surface: { max: 0.15 },
  surfaceAlt: { max: 0.15 },
  primary: { min: 0.25 },
  secondary: { min: 0.15 },
  accent: { min: 0.45 },
};

/**
 * Cap on the chroma-excess term, in band widths. Past twice the allowed
 * chroma a colour simply is not the kind of colour that role wants, and
 * further excess carries no additional information for the search.
 */
export const CHROMA_EXCESS_CAP = 2;

/** Weight of each cost term. See the module header for the priority argument. */
export const ROLE_COST_WEIGHTS = {
  contrast: 3.0,
  derived: 1.5,
  dup: 2.0,
  order: 1.2,
  chroma: 1.0,
  hue: 0.8,
  area: 0.8,
};

/**
 * Contrast a foreground is aimed at when the background allows it. 4.5:1 is the
 * WCAG AA floor for body text (`CONTRAST_AA_BODY`); 7:1 is the WCAG AAA level,
 * used for the two surface roles because those carry continuous reading.
 */
export const COMFORT_TARGET = {
  onSurface: 7.0, onSurfaceAlt: 7.0,
  onPrimary: CONTRAST_AA_BODY, onSecondary: CONTRAST_AA_BODY, onAccent: CONTRAST_AA_BODY,
};

/**
 * Area importance per slot: how much the area evidence should influence the
 * choice. A page ground is the largest painted region on any page, so the
 * cluster with the most area is very likely to be it. An accent is by
 * definition a small-area colour, so area carries no signal for it at all.
 */
export const AREA_IMPORTANCE = {
  surface: 1.0, primary: 0.8, surfaceAlt: 0.5, secondary: 0.3, accent: 0.0,
};

/**
 * Elevation band between `surface` and `surfaceAlt`, in WCAG contrast ratio.
 * The upper bound is `CONTRAST_AA_NONTEXT` (3.0), the published threshold at
 * which two fills become distinguishable *as separate components*; above it the
 * pair reads as two different grounds rather than one ground and its elevation.
 * The lower bound is the loosest bound that still excludes an identical fill.
 */
export const ELEVATION_BAND = { min: 1.05, max: CONTRAST_AA_NONTEXT };

/**
 * Minimum hue separation between `primary` and `accent`, in degrees. The sRGB
 * hue circle carries twelve nameable hue categories (the classic twelve-hue
 * wheel), so one category is 30° — the smallest separation at which the two
 * colours can be *named* differently.
 */
export const MIN_PRIMARY_ACCENT_HUE = 360 / 12;

/**
 * Two colours closer than this in OKLab are the same fill for layout purposes.
 * CIEDE2000 puts a just-noticeable difference at ΔE ≈ 1 on CIELab's 0..100
 * lightness scale, which is ΔE ≈ 0.01 on OKLab's 0..1 scale; doubled, because
 * "the same fill" is a stronger claim than "indistinguishable at a hairline".
 */
export const DUPLICATE_DELTA_E = 0.02;

/** Below this chroma fraction a colour has no meaningful hue to separate. */
const NEUTRAL_CHROMA_FRACTION = 0.15;

/** Cap on the candidate pool; 16^5 = 1,048,576 leaves bounds the worst-case search. */
export const POOL_CAP = 16;

/**
 * How many extracted colours seed derived variants, and what those variants
 * are. A brand with two colours has no material for a distinct accent, and the
 * alternative is worse than deriving one: either two roles collapse onto the
 * same fill, or a neutral lands in `primary` and the brand loses its colour.
 *
 * Each seed yields, at the seed's own hue:
 *   - `deep` — lightness halved, the midpoint between the seed and black;
 *   - `soft` — lightness halfway to white;
 *   - `vivid` — the cusp of that hue, its most chromatic point in sRGB
 *     (chromatic seeds only; a neutral has no cusp worth visiting).
 * Every lightness here is a midpoint or a computed cusp, not a chosen number.
 */
export const MAX_VARIANT_SEEDS = 2;

/**
 * Headroom applied when deriving. The guarantee itself is verified at exactly
 * the floor on the quantised colour, so this margin is not load-bearing; it
 * exists so a later theme adjustment or a colour-management round trip cannot
 * push a derived colour under the floor.
 */
export const DERIVE_MARGIN = 1.02;

/**
 * Hue tolerance for adopting a brand colour into a semantic role: one hue
 * category, the same 30° used for primary/accent separation.
 */
export const SEMANTIC_HUE_TOLERANCE = MIN_PRIMARY_ACCENT_HUE;

/**
 * Chroma fraction used when a semantic colour must be synthesised: 0.8 of the
 * maximum available at the hue's cusp. Status colours are meant to be read at a
 * glance, so they sit near the vivid end of their hue, but not at the very
 * boundary of the gamut where 8-bit quantisation is coarsest.
 */
export const SEMANTIC_CHROMA_FRACTION = 0.8;

/**
 * Tint carried by the synthesised neutral anchors: half of the surface chroma
 * ceiling, so an anchor is recognisably the brand's neutral rather than a
 * generic grey, while staying well inside the band a surface is allowed.
 */
export const ANCHOR_TINT_FRACTION = CHROMA_BANDS.surface.max / 2;

/**
 * @typedef {object} Candidate
 * @property {string} hex
 * @property {[number, number, number]} oklch
 * @property {[number, number, number]} lab
 * @property {number} luminance WCAG relative luminance
 * @property {number} weight area-derived weight, 0..1
 * @property {number} chromaFraction chroma as a fraction of the sRGB maximum here
 * @property {number} ceiling highest contrast any colour can reach against this one
 * @property {'extracted'|'derived'} source
 * @property {number|null} clusterIndex
 */

/**
 * Coerce whatever shape a caller has into `{hex, weight}`.
 * @param {any} c
 * @returns {{hex: string, weight: number}|null}
 */
function clusterToColor(c) {
  if (c == null) return null;
  if (typeof c === 'string') {
    try { return { hex: normalizeHex(c), weight: 1 }; } catch { return null; }
  }
  if (typeof c !== 'object') return null;
  const weight = Number.isFinite(c.weight) && c.weight > 0 ? c.weight
    : (Number.isFinite(c.share) && c.share > 0 ? c.share : 1);
  if (typeof c.hex === 'string') {
    try { return { hex: normalizeHex(c.hex), weight }; } catch { return null; }
  }
  if (Array.isArray(c.oklch) && c.oklch.length === 3) return { hex: oklchToHex(c.oklch), weight };
  if (Array.isArray(c.center) && c.center.length === 3) {
    return { hex: rgbToHex(hexToRgb(oklchToHex([c.center[0], Math.hypot(c.center[1], c.center[2]),
      (Math.atan2(c.center[2], c.center[1]) * 180 / Math.PI + 360) % 360]))), weight };
  }
  if (Array.isArray(c.rgb) && c.rgb.length >= 3) return { hex: rgbToHex(c.rgb), weight };
  return null;
}

/**
 * @param {string} hex
 * @param {number} weight
 * @param {'extracted'|'derived'} source
 * @param {number|null} clusterIndex
 * @returns {Candidate}
 */
function makeCandidate(hex, weight, source, clusterIndex) {
  const oklch = hexToOklch(hex);
  const maxC = maxChromaAt(oklch[0], oklch[2]);
  return {
    hex,
    oklch,
    lab: hexToOklab(hex),
    luminance: luminanceOfHex(hex),
    weight,
    chromaFraction: maxC > 0 ? Math.min(1, oklch[1] / maxC) : 0,
    ceiling: contrastCeiling(hex),
    source,
    clusterIndex,
  };
}

/**
 * Derived variants of one extracted colour, at the same hue. See
 * `MAX_VARIANT_SEEDS` for why they exist and how each lightness is chosen.
 * @param {Candidate} seed
 * @returns {{hex: string}[]}
 */
export function variantCandidates(seed) {
  const [L, , H] = seed.oklch;
  const frac = seed.chromaFraction;
  /** @type {{hex: string}[]} */
  const out = [];
  const atL = (nl) => oklchToHex([nl, frac * maxChromaAt(nl, H), H]);
  out.push({ hex: atL(L / 2) });
  out.push({ hex: atL((L + 1) / 2) });
  if (frac >= NEUTRAL_CHROMA_FRACTION) {
    const cusp = hueCusp(H);
    out.push({ hex: oklchToHex([cusp.L, cusp.C, H]) });
  }
  return out;
}

/**
 * Build the candidate pool: every cluster, plus pure white, pure black, a
 * near-white and near-black carrying the brand's dominant hue, and lightness
 * variants of the heaviest extracted colours. Everything but the clusters is
 * marked `derived` so the fidelity term prices its use; they exist so a brand
 * that extracted no usable ground (a two-colour logo, a neon-only palette)
 * still gets a readable, structurally distinct theme instead of a collapsed one.
 *
 * @param {readonly any[]} clusters
 * @returns {Candidate[]}
 */
export function buildCandidatePool(clusters) {
  /** @type {Candidate[]} */
  const extracted = [];
  /** @type {Map<string, number>} */
  const seen = new Map();
  let i = 0;
  for (const raw of clusters || []) {
    const c = clusterToColor(raw);
    if (!c) continue;
    if (seen.has(c.hex)) {
      const at = seen.get(c.hex);
      extracted[at].weight += c.weight;
      continue;
    }
    seen.set(c.hex, extracted.length);
    extracted.push(makeCandidate(c.hex, c.weight, 'extracted', i));
    i++;
  }
  if (extracted.length === 0) {
    throw new ContrastSolveError('solveRoles: no usable colours in the cluster set');
  }
  // Dominant hue: circular mean over clusters weighted by area and chroma, so a
  // large neutral cannot drag the tint toward an arbitrary hue.
  const hue = meanHue(extracted.map((c) => ({ h: c.oklch[2], w: c.weight * c.oklch[1] })));
  const { light, dark } = neutralAnchors(hue, ANCHOR_TINT_FRACTION);
  /** @type {Candidate[]} */
  const pool = extracted.slice();
  const totalWeight = extracted.reduce((a, c) => a + c.weight, 0) || 1;
  // Anchors carry the smallest weight in the pool so the area term never
  // prefers them; their value is structural, not evidential.
  const anchorWeight = Math.min(...extracted.map((c) => c.weight)) / (totalWeight * POOL_CAP);
  /** @type {Candidate[]} */
  const anchors = [];
  for (const hex of [light, dark, '#ffffff', '#000000']) {
    if (seen.has(hex)) continue;
    seen.set(hex, anchors.length);
    anchors.push(makeCandidate(hex, anchorWeight, 'derived', null));
  }
  /** @type {Candidate[]} */
  const variants = [];
  const seeds = extracted.slice()
    .sort((a, b) => (b.weight - a.weight) || (a.hex < b.hex ? -1 : 1))
    .slice(0, MAX_VARIANT_SEEDS);
  for (const seed of seeds) {
    for (const v of variantCandidates(seed)) {
      if (seen.has(v.hex)) continue;
      seen.set(v.hex, variants.length);
      variants.push(makeCandidate(v.hex, anchorWeight, 'derived', null));
    }
  }
  // Priority when the cap bites: the brand's own colours, then the structural
  // anchors that guarantee a readable ground, then the convenience variants.
  const ordered = extracted.slice()
    .sort((a, b) => (b.weight - a.weight) || (a.hex < b.hex ? -1 : 1))
    .concat(anchors, variants);
  return ordered.slice(0, POOL_CAP);
}

/**
 * Shortfall of `value` below `target`, normalised to 0..1.
 * @param {number} value
 * @param {number} target
 * @returns {number}
 */
function shortfall(value, target) {
  if (target <= 0) return 0;
  return Math.max(0, Math.min(1, (target - value) / target));
}

/**
 * @typedef {object} SolveContext
 * @property {Candidate[]} pool
 * @property {number} minRatio
 * @property {number[][]} contrast pairwise contrast matrix
 * @property {number} maxWeight
 */

/**
 * @param {Candidate[]} pool
 * @param {number} minRatio
 * @returns {SolveContext}
 */
export function buildContext(pool, minRatio) {
  const n = pool.length;
  const contrast = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let a = 0; a < n; a++) {
    for (let b = a; b < n; b++) {
      const r = contrastFromLuminance(pool[a].luminance, pool[b].luminance);
      contrast[a][b] = r;
      contrast[b][a] = r;
    }
  }
  return { pool, minRatio, contrast, maxWeight: Math.max(...pool.map((c) => c.weight), 1e-12) };
}

/**
 * Per-slot, per-candidate cost. Every term here depends only on the candidate
 * and the pool, never on the other slots, which is what makes the
 * branch-and-bound bound admissible.
 *
 * @param {string} slot
 * @param {number} ci
 * @param {SolveContext} ctx
 * @returns {{total: number, terms: Record<string, number>}}
 */
export function unaryCost(slot, ci, ctx) {
  const cand = ctx.pool[ci];
  const fgRole = SLOT_FOREGROUND[slot];

  // 1. Contrast. What is the best foreground this background can carry — from
  //    the pool, or by derivation (which reaches the ceiling)? Measured against
  //    the comfort target, not just the floor.
  let bestFromPool = 1;
  for (let j = 0; j < ctx.pool.length; j++) {
    const r = ctx.contrast[ci][j];
    if (r > bestFromPool) bestFromPool = r;
  }
  const reachable = Math.max(bestFromPool, cand.ceiling);
  const contrastTerm = shortfall(reachable, COMFORT_TARGET[fgRole]);

  // 2. Fidelity: a synthesised anchor is a concession.
  const derivedTerm = cand.source === 'derived' ? 1 : 0;

  // 3. Ordering: a page ground belongs at an extreme of lightness.
  let orderTerm = 0;
  if (slot === 'surface') orderTerm = (0.5 - Math.abs(cand.oklch[0] - 0.5)) / 0.5;
  else if (slot === 'surfaceAlt') orderTerm = 0.5 * (0.5 - Math.abs(cand.oklch[0] - 0.5)) / 0.5;

  // 4. Chroma appropriateness, measured in band widths outside the band. A
  //    surface allowed 0.15 of the available chroma that carries 0.45 is at
  //    two band widths, not at "0.3 of the way to maximum" — measuring the
  //    violation against the bound rather than against the full 0..1 range is
  //    what makes "surfaces don't want chroma" (§7) actually bind.
  const band = CHROMA_BANDS[slot];
  let chromaTerm = 0;
  if (band.max !== undefined && cand.chromaFraction > band.max) {
    chromaTerm = Math.min(CHROMA_EXCESS_CAP, (cand.chromaFraction - band.max) / band.max);
  } else if (band.min !== undefined && cand.chromaFraction < band.min) {
    // Scaled by the same cap as the excess side: a role that requires chroma
    // and gets none is exactly as wrong as a role that forbids chroma and gets
    // twice its budget, so both sides of a band reach the same severity.
    chromaTerm = CHROMA_EXCESS_CAP * (band.min - cand.chromaFraction) / band.min;
  }

  // 5. Area evidence.
  const areaTerm = AREA_IMPORTANCE[slot] * (1 - Math.min(1, cand.weight / ctx.maxWeight));

  const terms = {
    contrast: contrastTerm, derived: derivedTerm, order: orderTerm,
    chroma: chromaTerm, area: areaTerm,
  };
  let total = 0;
  for (const [k, v] of Object.entries(terms)) total += ROLE_COST_WEIGHTS[k] * v;
  return { total, terms };
}

/**
 * Cost terms that depend on more than one slot.
 * @param {readonly number[]} pick indices into the pool, one per BACKGROUND_SLOTS
 * @param {SolveContext} ctx
 * @returns {{total: number, terms: Record<string, number>}}
 */
export function binaryCost(pick, ctx) {
  const idx = {};
  BACKGROUND_SLOTS.forEach((s, i) => { idx[s] = pick[i]; });
  const pool = ctx.pool;
  const surface = pool[idx.surface];
  const alt = pool[idx.surfaceAlt];
  const primary = pool[idx.primary];
  const accent = pool[idx.accent];

  // Elevation band between the two surfaces.
  const elevation = ctx.contrast[idx.surface][idx.surfaceAlt];
  let orderTerm = 0;
  if (elevation < ELEVATION_BAND.min) {
    orderTerm += (ELEVATION_BAND.min - elevation) / (ELEVATION_BAND.min - 1);
  } else if (elevation > ELEVATION_BAND.max) {
    orderTerm += (elevation - ELEVATION_BAND.max) / (MAX_CONTRAST - ELEVATION_BAND.max);
  }
  // Lightness ordering: the ground sits further from mid-lightness than the
  // alternate surface, so the alternate reads as a step in from the ground.
  const groundExtremity = Math.abs(surface.oklch[0] - 0.5);
  const altExtremity = Math.abs(alt.oklch[0] - 0.5);
  if (altExtremity > groundExtremity) orderTerm += (altExtremity - groundExtremity) / 0.5;

  // Primary/accent separation: by hue when both are colourful, by perceptual
  // distance when either is effectively neutral and hue means nothing.
  let hueTerm;
  if (primary.chromaFraction >= NEUTRAL_CHROMA_FRACTION && accent.chromaFraction >= NEUTRAL_CHROMA_FRACTION) {
    const d = hueDistance(primary.oklch[2], accent.oklch[2]);
    hueTerm = Math.max(0, MIN_PRIMARY_ACCENT_HUE - d) / MIN_PRIMARY_ACCENT_HUE;
  } else {
    const d = deltaEok(primary.lab, accent.lab);
    hueTerm = Math.max(0, 0.15 - d) / 0.15;
  }

  // Duplication. The sum of the collision weights, deliberately uncapped: each
  // additional collision must cost more than the last, and a normalised term
  // would let a palette buy its second collision for almost nothing.
  let dupTerm = 0;
  for (let a = 0; a < BACKGROUND_SLOTS.length; a++) {
    for (let b = a + 1; b < BACKGROUND_SLOTS.length; b++) {
      const w = DUP_PAIR_WEIGHT[`${BACKGROUND_SLOTS[a]}|${BACKGROUND_SLOTS[b]}`] ?? DUP_PAIR_DEFAULT;
      if (deltaEok(pool[pick[a]].lab, pool[pick[b]].lab) < DUPLICATE_DELTA_E) dupTerm += w;
    }
  }

  const terms = { order: orderTerm, hue: hueTerm, dup: dupTerm };
  const total = ROLE_COST_WEIGHTS.order * orderTerm
    + ROLE_COST_WEIGHTS.hue * hueTerm
    + ROLE_COST_WEIGHTS.dup * dupTerm;
  return { total, terms };
}

/**
 * How damaging it is for two roles to resolve to the same fill. Primary and
 * accent collapsing removes the brand's only colour contrast; surface and
 * surfaceAlt collapsing removes every elevation cue in every layout.
 */
const DUP_PAIR_WEIGHT = {
  'surface|surfaceAlt': 1.0,
  'surface|primary': 1.0,
  'primary|accent': 1.0,
  'surface|accent': 0.9,
  'surface|secondary': 0.9,
  'primary|secondary': 0.8,
  'secondary|accent': 0.8,
  'surfaceAlt|primary': 0.6,
  'surfaceAlt|accent': 0.6,
  'surfaceAlt|secondary': 0.5,
};
const DUP_PAIR_DEFAULT = 0.5;

/**
 * Exhaustive depth-first search with branch-and-bound pruning over the
 * `pool^5` background assignments.
 * @param {SolveContext} ctx
 * @returns {{pick: number[], cost: number, leaves: number, terms: Record<string, number>}}
 */
export function searchAssignment(ctx) {
  const S = BACKGROUND_SLOTS.length;
  const P = ctx.pool.length;
  const unary = BACKGROUND_SLOTS.map((slot) => {
    const row = new Float64Array(P);
    for (let ci = 0; ci < P; ci++) row[ci] = unaryCost(slot, ci, ctx).total;
    return row;
  });
  // Candidates per slot, cheapest first; index breaks ties so the order is total.
  const order = unary.map((row) => Array.from({ length: P }, (_, i) => i)
    .sort((a, b) => (row[a] - row[b]) || (a - b)));
  const minUnary = unary.map((row) => Math.min(...row));
  const suffix = new Float64Array(S + 1);
  for (let i = S - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + minUnary[i];

  const pick = new Int32Array(S);
  /** @type {number[]|null} */
  let best = null;
  let bestCost = Infinity;
  let leaves = 0;

  /** @param {number} si @param {number} acc */
  const dfs = (si, acc) => {
    if (si === S) {
      leaves++;
      const total = acc + binaryCost(pick, ctx).total;
      if (total < bestCost) { bestCost = total; best = Array.from(pick); }
      return;
    }
    for (const ci of order[si]) {
      const next = acc + unary[si][ci];
      // Ordered ascending, so once the bound fails it fails for the rest.
      if (next + suffix[si + 1] >= bestCost) break;
      pick[si] = ci;
      dfs(si + 1, next);
    }
  };
  dfs(0, 0);

  if (best === null) {
    // Only reachable when the pool is empty, which buildCandidatePool prevents.
    throw new ContrastSolveError('solveRoles: the assignment search found no candidate');
  }
  const bin = binaryCost(best, ctx);
  /** @type {Record<string, number>} */
  const terms = { ...bin.terms };
  BACKGROUND_SLOTS.forEach((slot, i) => {
    const u = unaryCost(slot, best[i], ctx).terms;
    for (const [k, v] of Object.entries(u)) terms[k] = (terms[k] || 0) + v;
  });
  return { pick: best, cost: bestCost, leaves, terms };
}

/**
 * Choose the lowest-cost item. Exact ties are broken by a draw from the
 * `brand/derive` substream rather than by array order, so a tie is recorded as
 * a coin flip with a seed instead of hiding as an accident of iteration.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => number} costOf
 * @param {import('../core/prng.js').Pcg32} rng
 * @returns {T|null}
 */
function pickLowest(items, costOf, rng) {
  if (items.length === 0) return null;
  let best = Infinity;
  /** @type {T[]} */
  let tied = [];
  for (const item of items) {
    const c = costOf(item);
    if (c < best - 1e-12) { best = c; tied = [item]; } else if (Math.abs(c - best) <= 1e-12) tied.push(item);
  }
  return tied.length === 1 ? tied[0] : rng.pick(tied);
}

/**
 * The lightness at which a hue reaches its maximum chroma in sRGB — the cusp of
 * that hue leaf. Found by golden-section search over a unimodal function, so no
 * lightness is ever picked by eye.
 * @param {number} hue degrees
 * @returns {{L: number, C: number}}
 */
export function hueCusp(hue) {
  const phi = (Math.sqrt(5) - 1) / 2;
  let a = 0;
  let b = 1;
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  let fc = maxChromaAt(c, hue);
  let fd = maxChromaAt(d, hue);
  for (let i = 0; i < 48; i++) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = maxChromaAt(c, hue); } else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = maxChromaAt(d, hue); }
  }
  const L = (a + b) / 2;
  return { L, C: maxChromaAt(L, hue) };
}

/**
 * Choose or derive a foreground for one background.
 * @param {string} role
 * @param {string} bgHex
 * @param {SolveContext} ctx
 * @param {import('../core/prng.js').Pcg32} rng
 * @returns {{hex: string, source: 'extracted'|'derived'}}
 */
function resolveForeground(role, bgHex, ctx, rng) {
  const bgY = luminanceOfHex(bgHex);
  const target = COMFORT_TARGET[role] ?? ctx.minRatio;
  const eligible = ctx.pool.filter((c) => contrastFromLuminance(c.luminance, bgY) >= ctx.minRatio);
  if (eligible.length > 0) {
    const chosen = pickLowest(eligible, (c) => {
      const r = contrastFromLuminance(c.luminance, bgY);
      // Shortfall against the comfort target, then a preference for low-chroma
      // text (a vivid foreground on a vivid ground vibrates), then a mild
      // preference for colours the brand actually uses a lot of.
      return 2 * shortfall(r, target)
        + 0.5 * c.chromaFraction
        + 0.3 * (1 - Math.min(1, c.weight / ctx.maxWeight))
        + (c.source === 'derived' ? 0.4 : 0);
    }, rng);
    if (chosen) return { hex: chosen.hex, source: chosen.source };
  }
  // Nothing extracted works. Walk lightness on the background's own hue, which
  // keeps the derived foreground inside the brand's colour family.
  const ceiling = contrastCeiling(bgHex);
  const want = Math.min(Math.max(ctx.minRatio * DERIVE_MARGIN, Math.min(target, ceiling)), ceiling);
  const hex = deriveForContrast(bgHex, bgHex, want);
  return { hex, source: 'derived' };
}

/**
 * Choose or derive the border colour. §4 pairs `border` with `surface`; WCAG
 * 1.4.11 requires 3:1 for the boundary of a user-interface component, which is
 * `CONTRAST_AA_NONTEXT`, so that is the target rather than a subtler hairline.
 * @param {string} surfaceHex
 * @param {SolveContext} ctx
 * @param {import('../core/prng.js').Pcg32} rng
 * @returns {{hex: string, source: 'extracted'|'derived'}}
 */
function resolveBorder(surfaceHex, ctx, rng) {
  const y = luminanceOfHex(surfaceHex);
  const eligible = ctx.pool.filter((c) => contrastFromLuminance(c.luminance, y) >= CONTRAST_AA_NONTEXT);
  if (eligible.length > 0) {
    const chosen = pickLowest(eligible, (c) => {
      const r = contrastFromLuminance(c.luminance, y);
      // Closest to 3:1 wins: a border that meets the threshold and no more is a
      // border rather than a second foreground.
      return (r - CONTRAST_AA_NONTEXT) / (MAX_CONTRAST - CONTRAST_AA_NONTEXT)
        + 0.5 * c.chromaFraction
        + (c.source === 'derived' ? 0.3 : 0);
    }, rng);
    if (chosen) return { hex: chosen.hex, source: chosen.source };
  }
  return {
    hex: deriveForContrast(surfaceHex, surfaceHex, CONTRAST_AA_NONTEXT * DERIVE_MARGIN),
    source: 'derived',
  };
}

/**
 * Canonical hues for the semantic roles, taken from the sRGB primaries and
 * secondaries themselves (`SRGB_HUES`) rather than chosen: `danger` is the hue
 * of `#ff0000`, `warning` of `#ffff00`, `success` of `#00ff00`.
 */
export const SEMANTIC_HUES = {
  success: SRGB_HUES.green,
  warning: SRGB_HUES.yellow,
  danger: SRGB_HUES.red,
};

/**
 * Choose or synthesise a semantic colour. A brand colour is adopted when it is
 * within one hue category of the canonical hue and already legible on the
 * surface; otherwise the colour is built at the canonical hue's gamut cusp and
 * walked in lightness until it is legible.
 *
 * Semantic colours are status *text* in every layout that uses them, so they
 * are held to the body-text floor even though §4 does not list them as
 * foreground roles.
 *
 * @param {string} role
 * @param {string} surfaceHex
 * @param {SolveContext} ctx
 * @param {import('../core/prng.js').Pcg32} rng
 * @returns {{hex: string, source: 'extracted'|'derived'}}
 */
function resolveSemantic(role, surfaceHex, ctx, rng) {
  const hue = SEMANTIC_HUES[role];
  const y = luminanceOfHex(surfaceHex);
  const eligible = ctx.pool.filter((c) => c.source === 'extracted'
    && c.chromaFraction >= NEUTRAL_CHROMA_FRACTION
    && hueDistance(c.oklch[2], hue) <= SEMANTIC_HUE_TOLERANCE
    && contrastFromLuminance(c.luminance, y) >= ctx.minRatio);
  if (eligible.length > 0) {
    const chosen = pickLowest(eligible, (c) => hueDistance(c.oklch[2], hue) / SEMANTIC_HUE_TOLERANCE
      + 0.5 * (1 - c.chromaFraction), rng);
    if (chosen) return { hex: chosen.hex, source: 'extracted' };
  }
  const cusp = hueCusp(hue);
  const base = oklchToHex([cusp.L, cusp.C * SEMANTIC_CHROMA_FRACTION, hue]);
  return {
    hex: deriveForContrast(base, surfaceHex, ctx.minRatio * DERIVE_MARGIN),
    source: 'derived',
  };
}

/**
 * Build the `ColorToken` for one role.
 * @param {string} role
 * @param {string} hex
 * @param {'extracted'|'derived'|'manual'} source
 * @param {Record<string, string>} byRole
 * @returns {import('../core/contracts.d.ts').ColorToken}
 */
function toToken(role, hex, source, byRole) {
  const pair = ROLE_PAIR[role];
  const pairHex = pair ? byRole[pair] : null;
  const lch = hexToOklch(hex);
  return {
    role: /** @type {any} */ (role),
    hex,
    oklch: [lch[0], lch[1], lch[2]],
    source,
    contrastWithPair: pairHex ? contrastRatio(hex, pairHex) : null,
  };
}

/**
 * Verify the §7 post-condition on a finished palette.
 * @param {readonly import('../core/contracts.d.ts').ColorToken[]} tokens
 * @param {number} [minRatio]
 * @returns {{role: string, pair: string, ratio: number, ok: boolean}[]}
 */
export function paletteContrastReport(tokens, minRatio = CONTRAST_AA_BODY) {
  /** @type {Record<string, string>} */
  const byRole = {};
  for (const t of tokens) byRole[t.role] = t.hex;
  return FOREGROUND_ROLES.map((role) => {
    const pair = ROLE_PAIR[role];
    const ratio = contrastRatio(byRole[role], byRole[pair]);
    return { role, pair, ratio, ok: ratio >= minRatio };
  });
}

/**
 * Throw unless every foreground role meets the floor.
 * @param {readonly import('../core/contracts.d.ts').ColorToken[]} tokens
 * @param {number} [minRatio]
 */
export function assertPaletteContrast(tokens, minRatio = CONTRAST_AA_BODY) {
  const failures = paletteContrastReport(tokens, minRatio).filter((r) => !r.ok);
  if (failures.length > 0) {
    const detail = failures.map((f) => `${f.role} on ${f.pair} = ${f.ratio.toFixed(3)}:1`).join(', ');
    throw new ContrastSolveError(
      `solveRoles post-condition failed: ${detail} (floor ${minRatio}:1)`,
    );
  }
}

/**
 * The §7 solve. Takes the cluster set, returns a full `ColorToken[]` in
 * `COLOR_ROLES` order in which every foreground role meets 4.5:1 against its
 * pair — or throws.
 *
 * @param {readonly any[]} clusters clusters from `quantize`, or plain `{hex, weight}` records
 * @param {{seed?: any, minRatio?: number, trace?: boolean}} [options]
 * @returns {import('../core/contracts.d.ts').ColorToken[]}
 */
export function solveRoles(clusters, options = {}) {
  const minRatio = Number.isFinite(options.minRatio) ? Number(options.minRatio) : CONTRAST_AA_BODY;
  if (!(minRatio > 1)) {
    throw new ContrastSolveError(`solveRoles: minRatio must be greater than 1, got ${options.minRatio}`);
  }
  if (minRatio > MAX_CONTRAST) {
    throw new ContrastSolveError(
      `solveRoles: minRatio ${minRatio}:1 exceeds the maximum contrast ratio any two sRGB colours can reach (${MAX_CONTRAST}:1)`,
    );
  }
  if (!Array.isArray(clusters) || clusters.length === 0) {
    throw new ContrastSolveError('solveRoles: the cluster set is empty');
  }

  const pool = buildCandidatePool(clusters);
  const ctx = buildContext(pool, minRatio);
  const search = searchAssignment(ctx);
  const rng = new SeedBook(options.seed ?? DEFAULT_SEED).fresh(DERIVE_STREAM);

  /** @type {Record<string, string>} */
  const byRole = {};
  /** @type {Record<string, 'extracted'|'derived'|'manual'>} */
  const sources = {};
  BACKGROUND_SLOTS.forEach((slot, i) => {
    const cand = pool[search.pick[i]];
    byRole[slot] = cand.hex;
    sources[slot] = cand.source;
  });

  for (const slot of BACKGROUND_SLOTS) {
    const role = SLOT_FOREGROUND[slot];
    let resolved;
    try {
      resolved = resolveForeground(role, byRole[slot], ctx, rng);
    } catch (e) {
      if (e instanceof DeriveError) {
        throw new ContrastSolveError(`solveRoles: cannot satisfy ${role} on ${slot}: ${e.message}`);
      }
      throw e;
    }
    byRole[role] = resolved.hex;
    sources[role] = resolved.source;
  }

  const border = resolveBorder(byRole.surface, ctx, rng);
  byRole.border = border.hex;
  sources.border = border.source;

  for (const role of ['success', 'warning', 'danger']) {
    const r = resolveSemantic(role, byRole.surface, ctx, rng);
    byRole[role] = r.hex;
    sources[role] = r.source;
  }

  const tokens = COLOR_ROLES.map((role) => toToken(role, byRole[role], sources[role] || 'derived', byRole));

  // The hard post-condition (§7, PLAN §4.1). Unreachable by construction —
  // derivation cannot fail below 4.5826:1 — and checked anyway, because a
  // post-condition that is only argued is not a post-condition.
  assertPaletteContrast(tokens, minRatio);

  if (options.trace) {
    Object.defineProperty(tokens, 'solveTrace', {
      value: { cost: search.cost, leaves: search.leaves, terms: search.terms, pool: pool.length },
      enumerable: false,
    });
  }
  return tokens;
}

export { COLOR_ROLES, ROLE_PAIR, FOREGROUND_ROLES, BACKGROUND_ROLES, CONTRAST_AA_BODY };
