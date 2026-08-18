/**
 * The adversarial brand-palette corpus required by §17.2 and PLAN §4.1, plus
 * the synthetic generators the clustering tests use.
 *
 * Each entry is a *hostile* palette — one that a naive "assign the darkest to
 * onSurface" heuristic gets wrong. The weights are the area weights the
 * clustering stage would have produced; they matter, because area weighting is
 * part of what the solver is being asked to get right.
 */

import { Pcg32 } from '../../../src/core/prng.js';

/**
 * @typedef {object} AdversarialPalette
 * @property {string} name
 * @property {string} hostility what a naive solver gets wrong here
 * @property {{hex: string, weight: number}[]} clusters
 */

/** @type {AdversarialPalette[]} */
export const ADVERSARIAL_PALETTES = [
  {
    name: 'near-white primary',
    hostility: 'the brand colour is almost white; white text on it is unreadable',
    clusters: [
      { hex: '#fdfdfb', weight: 0.52 },
      { hex: '#f2f2ee', weight: 0.26 },
      { hex: '#e8e8e2', weight: 0.14 },
      { hex: '#111111', weight: 0.08 },
    ],
  },
  {
    name: 'neon accent on black',
    hostility: 'a single blinding accent and two near-identical blacks',
    clusters: [
      { hex: '#39ff14', weight: 0.18 },
      { hex: '#0a0a0a', weight: 0.62 },
      { hex: '#141414', weight: 0.20 },
    ],
  },
  {
    name: 'monochrome',
    hostility: 'no hue at all; every hue-based heuristic divides by zero',
    clusters: [
      { hex: '#000000', weight: 0.30 },
      { hex: '#7a7a7a', weight: 0.25 },
      { hex: '#ffffff', weight: 0.45 },
    ],
  },
  {
    name: 'single hue',
    hostility: 'four lightnesses of one blue; primary and accent cannot differ in hue',
    clusters: [
      { hex: '#0d47a1', weight: 0.30 },
      { hex: '#1565c0', weight: 0.28 },
      { hex: '#1976d2', weight: 0.22 },
      { hex: '#42a5f5', weight: 0.20 },
    ],
  },
  {
    name: 'ultra dark',
    hostility: 'every colour is within a hair of black; contrast headroom is one-sided',
    clusters: [
      { hex: '#050507', weight: 0.55 },
      { hex: '#0b0b10', weight: 0.30 },
      { hex: '#121218', weight: 0.15 },
    ],
  },
  {
    name: 'low-chroma grey',
    hostility: 'a full grey ramp with a whisper of blue; nothing qualifies as an accent',
    clusters: [
      { hex: '#f4f4f5', weight: 0.44 },
      { hex: '#d4d4d8', weight: 0.24 },
      { hex: '#a1a1aa', weight: 0.18 },
      { hex: '#52525b', weight: 0.14 },
    ],
  },
  {
    name: 'two colour',
    hostility: 'one brand colour and white; five background roles, two colours',
    clusters: [
      { hex: '#ff6600', weight: 0.35 },
      { hex: '#ffffff', weight: 0.65 },
    ],
  },
  {
    name: 'single colour',
    hostility: 'exactly one extracted colour; the entire theme must be derived around it',
    clusters: [
      { hex: '#7b1fa2', weight: 1 },
    ],
  },
  {
    name: 'mid-lightness everything',
    hostility: 'every colour sits near L=0.5, the worst possible contrast headroom',
    clusters: [
      { hex: '#7f7f7f', weight: 0.3 },
      { hex: '#8a6d3b', weight: 0.25 },
      { hex: '#3b6d8a', weight: 0.25 },
      { hex: '#6d8a3b', weight: 0.2 },
    ],
  },
  {
    name: 'saturated everything',
    hostility: 'six fully saturated hues and no neutral anywhere',
    clusters: [
      { hex: '#ff0000', weight: 0.2 },
      { hex: '#00ff00', weight: 0.2 },
      { hex: '#0000ff', weight: 0.2 },
      { hex: '#ffff00', weight: 0.15 },
      { hex: '#00ffff', weight: 0.15 },
      { hex: '#ff00ff', weight: 0.10 },
    ],
  },
  {
    name: 'warm retail',
    hostility: 'a warm off-white that looks chromatic relative to its own lightness',
    clusters: [
      { hex: '#ffffff', weight: 0.40 },
      { hex: '#f7f3ee', weight: 0.24 },
      { hex: '#8b5e3c', weight: 0.16 },
      { hex: '#d94f04', weight: 0.12 },
      { hex: '#2b2b2b', weight: 0.08 },
    ],
  },
  {
    name: 'eight clusters',
    hostility: 'the maximum k, with two pairs that are nearly duplicates',
    clusters: [
      { hex: '#1a1a2e', weight: 0.22 },
      { hex: '#16213e', weight: 0.18 },
      { hex: '#0f3460', weight: 0.14 },
      { hex: '#e94560', weight: 0.12 },
      { hex: '#f5f5f5', weight: 0.12 },
      { hex: '#c9c9c9', weight: 0.10 },
      { hex: '#53354a', weight: 0.07 },
      { hex: '#903749', weight: 0.05 },
    ],
  },
  {
    name: 'pastel',
    hostility: 'everything is light and low-contrast except one navy',
    clusters: [
      { hex: '#fef6e4', weight: 0.40 },
      { hex: '#f3d2c1', weight: 0.22 },
      { hex: '#8bd3dd', weight: 0.18 },
      { hex: '#001858', weight: 0.12 },
      { hex: '#172c66', weight: 0.08 },
    ],
  },
  {
    name: 'inverted weights',
    hostility: 'the page ground is the rarest colour by area, the accent the most common',
    clusters: [
      { hex: '#ffffff', weight: 0.05 },
      { hex: '#e94560', weight: 0.60 },
      { hex: '#1a1a2e', weight: 0.35 },
    ],
  },
];

/**
 * Inputs `solveRoles` must refuse rather than answer. Each carries the reason
 * it is impossible, so a failure message can be checked against intent.
 */
export const IMPOSSIBLE_INPUTS = [
  { name: 'empty cluster set', clusters: [], options: {}, why: 'nothing to assign' },
  { name: 'all-null clusters', clusters: [null, undefined], options: {}, why: 'no usable colours' },
  { name: 'unparseable colours', clusters: [{ hex: 'not-a-colour' }], options: {}, why: 'no usable colours' },
  {
    name: 'ratio above the maximum possible',
    clusters: [{ hex: '#3b2eea', weight: 1 }, { hex: '#ffffff', weight: 1 }],
    options: { minRatio: 22 },
    why: 'no two sRGB colours exceed 21:1',
  },
  {
    name: 'ratio exactly at the impossible boundary',
    clusters: [{ hex: '#3b2eea', weight: 1 }, { hex: '#ffffff', weight: 1 }],
    options: { minRatio: 21.000001 },
    why: 'just past the 21:1 ceiling',
  },
  {
    name: 'nonsensical ratio',
    clusters: [{ hex: '#3b2eea', weight: 1 }],
    options: { minRatio: 0.5 },
    why: 'a contrast ratio below 1:1 does not exist',
  },
];

/**
 * Deterministic synthetic pixels around known centres, for k-selection and
 * clustering tests. Jitter is Gaussian in 8-bit RGB from a named substream.
 *
 * @param {readonly string[]} centers hex centres
 * @param {{perCluster?: number, jitter?: number, seed?: string}} [options]
 * @returns {number[][]} `[r,g,b]` triples
 */
export function syntheticPixels(centers, options = {}) {
  const perCluster = options.perCluster ?? 120;
  const jitter = options.jitter ?? 4;
  const rng = new Pcg32(options.seed ?? 'test/brand/synthetic', 7);
  /** @type {number[][]} */
  const out = [];
  for (const hex of centers) {
    const base = [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
    for (let i = 0; i < perCluster; i++) {
      out.push(base.map((c) => Math.min(255, Math.max(0, Math.round(c + rng.nextGaussian() * jitter)))));
    }
  }
  return out;
}

/** Well-separated centres used by the k-selection test; k is known by construction. */
export const KNOWN_K_CENTERS = {
  3: ['#e8143c', '#1436e8', '#f5f5f5'],
  4: ['#e8143c', '#1436e8', '#f5f5f5', '#141414'],
  5: ['#e8143c', '#1436e8', '#f5f5f5', '#141414', '#14e83c'],
  6: ['#e8143c', '#1436e8', '#f5f5f5', '#141414', '#14e83c', '#e8c814'],
};
