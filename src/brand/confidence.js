/**
 * Colour confidence, computed (§7).
 *
 * "Confidence is computed from cluster separation, sample size, and agreement
 * across sources — never hardcoded." Those are the three factors, and they are
 * the only three:
 *
 *  - **Separation** — did clustering actually find structure? A silhouette-like
 *    ratio of each cluster's distance to its nearest neighbour against its own
 *    spread, weighted by area. Overlapping clusters mean the palette is an
 *    artefact of k, not a property of the brand.
 *  - **Sample size** — a saturating curve. Two hundred pixels of a logo is not
 *    the same evidence as a full page of computed styles.
 *  - **Agreement across sources** — do the stylesheet, the rendered page and
 *    the imagery point at the same colours? Measured as the mean pairwise
 *    cosine similarity of the per-source weight distributions over clusters.
 *
 * The three combine as a **weighted geometric mean**, not an arithmetic one:
 * a factor near zero must collapse the result. A palette with excellent
 * separation, a huge sample and no corroboration at all is not 0.7 confident.
 *
 * Where a factor genuinely cannot be measured — one source, so no agreement to
 * observe; one cluster, so no separation to observe; no sample counts recorded —
 * it takes `UNKNOWN_FACTOR`, which says "no evidence either way" rather than
 * pretending to either.
 *
 * @module brand/confidence
 */

import { deltaEok } from './oklab.js';

/**
 * Weights of the three factors. Separation leads because it is the only one
 * that measures whether a palette exists at all; the other two measure how well
 * it is evidenced.
 */
export const CONFIDENCE_WEIGHTS = { separation: 0.45, size: 0.30, agreement: 0.25 };

/**
 * The value a factor takes when it cannot be measured. Deliberately the exact
 * midpoint: an unmeasurable factor must neither reward nor punish.
 */
export const UNKNOWN_FACTOR = 0.5;

/**
 * Sample count at which the size factor reaches one half, `n / (n + N0)`.
 * k tops out at 8 (§7), and a centroid needs on the order of eight members
 * before its standard error falls to about a third of the cluster's own
 * spread, so 8 × 8 = 64 is the point where the sample stops being the limiting
 * factor.
 */
export const HALF_CONFIDENCE_SAMPLES = 64;

/** Floor applied inside the geometric mean so a zero factor cannot produce log(0). */
const FACTOR_FLOOR = 1e-6;

/**
 * Weighted mean cluster separation, mapped to 0..1.
 *
 * For each cluster: `(d − s) / max(d, s)` where `d` is the distance to the
 * nearest other centroid and `s` the cluster's own weighted RMS spread. That is
 * the silhouette coefficient evaluated at the centroid, so it is +1 for a
 * tight, isolated cluster and −1 for one entirely inside its neighbour; the
 * result is remapped from −1..1 to 0..1.
 *
 * @param {readonly any[]} clusters
 * @returns {number} 0..1, or `UNKNOWN_FACTOR` when separation is unmeasurable
 */
export function clusterSeparation(clusters) {
  const usable = (clusters || []).filter((c) => c && Array.isArray(c.center));
  if (usable.length < 2) return UNKNOWN_FACTOR;
  let num = 0;
  let den = 0;
  for (let i = 0; i < usable.length; i++) {
    let nearest = Infinity;
    for (let j = 0; j < usable.length; j++) {
      if (i === j) continue;
      const d = deltaEok(usable[i].center, usable[j].center);
      if (d < nearest) nearest = d;
    }
    const spread = Number.isFinite(usable[i].spread) ? usable[i].spread : 0;
    const denom = Math.max(nearest, spread);
    const s = denom > 0 ? (nearest - spread) / denom : 0;
    const w = Number.isFinite(usable[i].weight) && usable[i].weight > 0 ? usable[i].weight : 1;
    num += w * ((s + 1) / 2);
    den += w;
  }
  return den > 0 ? Math.min(1, Math.max(0, num / den)) : UNKNOWN_FACTOR;
}

/**
 * Saturating sample-size factor, `n / (n + HALF_CONFIDENCE_SAMPLES)`.
 * @param {number} n
 * @returns {number} 0..1
 */
export function sampleSizeFactor(n) {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n / (n + HALF_CONFIDENCE_SAMPLES);
}

/**
 * Total sample count across clusters, or null when no cluster records one.
 * @param {readonly any[]} clusters
 * @returns {number|null}
 */
export function totalSamples(clusters) {
  let n = 0;
  let seen = false;
  for (const c of clusters || []) {
    if (c && Number.isFinite(c.count)) { n += c.count; seen = true; }
  }
  return seen ? n : null;
}

/**
 * Normalise the `sources` argument into a list of source names.
 * Accepts `['computed','css']`, `[{origin:'computed'}, …]`, a count, or nothing.
 * @param {any} sources
 * @returns {string[]}
 */
export function normalizeSources(sources) {
  if (!sources) return [];
  if (typeof sources === 'number') {
    return Array.from({ length: Math.max(0, Math.floor(sources)) }, (_, i) => `source${i}`);
  }
  if (!Array.isArray(sources)) {
    if (typeof sources === 'object') return Object.keys(sources);
    return [];
  }
  /** @type {string[]} */
  const out = [];
  for (const s of sources) {
    if (typeof s === 'string') out.push(s);
    else if (s && typeof s === 'object' && typeof s.origin === 'string') out.push(s.origin);
  }
  return [...new Set(out)];
}

/**
 * Mean pairwise cosine similarity of the per-source weight distributions over
 * clusters. One source, or clusters that record no per-source weights, means
 * agreement cannot be observed.
 *
 * @param {readonly any[]} clusters
 * @param {any} [sources]
 * @returns {number} 0..1, or `UNKNOWN_FACTOR`
 */
export function sourceAgreement(clusters, sources) {
  const list = (clusters || []).filter(Boolean);
  /** @type {Map<string, number[]>} */
  const vectors = new Map();
  list.forEach((c, i) => {
    const sw = c && c.sourceWeights;
    if (!sw || typeof sw !== 'object') return;
    for (const [origin, w] of Object.entries(sw)) {
      if (!Number.isFinite(w) || w <= 0) continue;
      let v = vectors.get(origin);
      if (!v) { v = new Array(list.length).fill(0); vectors.set(origin, v); }
      v[i] += w;
    }
  });
  const declared = normalizeSources(sources);
  if (vectors.size < 2) {
    // No per-source breakdown to compare. If the caller named several sources
    // we still know corroboration was possible but cannot measure it, so the
    // factor stays at the "no evidence" midpoint either way.
    return declared.length >= 2 ? UNKNOWN_FACTOR : UNKNOWN_FACTOR;
  }
  const vs = [...vectors.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => {
    const total = v.reduce((a, x) => a + x, 0);
    return total > 0 ? v.map((x) => x / total) : v;
  });
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < vs.length; a++) {
    for (let b = a + 1; b < vs.length; b++) {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < vs[a].length; i++) {
        dot += vs[a][i] * vs[b][i];
        na += vs[a][i] * vs[a][i];
        nb += vs[b][i] * vs[b][i];
      }
      const denom = Math.sqrt(na) * Math.sqrt(nb);
      sum += denom > 0 ? dot / denom : 0;
      pairs++;
    }
  }
  return pairs > 0 ? Math.min(1, Math.max(0, sum / pairs)) : UNKNOWN_FACTOR;
}

/**
 * The §7 colour confidence: separation, sample size and cross-source agreement,
 * combined as a weighted geometric mean. Always in [0,1].
 *
 * @param {readonly any[]} clusters clusters from `quantize`
 * @param {any} [sources] source names, source records, or a count
 * @returns {number} 0..1
 */
export function colorConfidence(clusters, sources) {
  const separation = clusterSeparation(clusters);
  const n = totalSamples(clusters);
  const size = n === null ? UNKNOWN_FACTOR : sampleSizeFactor(n);
  const agreement = sourceAgreement(clusters, sources);
  const factors = { separation, size, agreement };
  let logSum = 0;
  for (const [k, w] of Object.entries(CONFIDENCE_WEIGHTS)) {
    logSum += w * Math.log(Math.max(FACTOR_FLOOR, Math.min(1, factors[k])));
  }
  const value = Math.exp(logSum);
  return Math.min(1, Math.max(0, value));
}

/**
 * The same computation, with its parts, for the studio's review surface — §7
 * requires low-confidence fields to be surfaced for review, and "why" is what
 * makes that review possible.
 * @param {readonly any[]} clusters
 * @param {any} [sources]
 * @returns {{confidence: number, separation: number, size: number, agreement: number, samples: number|null}}
 */
export function colorConfidenceDetail(clusters, sources) {
  const n = totalSamples(clusters);
  return {
    confidence: colorConfidence(clusters, sources),
    separation: clusterSeparation(clusters),
    size: n === null ? UNKNOWN_FACTOR : sampleSizeFactor(n),
    agreement: sourceAgreement(clusters, sources),
    samples: n,
  };
}
