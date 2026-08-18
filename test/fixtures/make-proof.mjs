/**
 * A proof builder for tests.
 *
 * Every lane needs a `Proof` to test against, and hand-writing one in each test
 * file guarantees they drift apart. This builder produces contract-valid proofs
 * deterministically — every id is content-derived or drawn from a named PRNG
 * substream, so two calls with the same arguments produce the same proof and
 * §17.6's byte-identical assertion means something.
 *
 * It is a test fixture, not lane code: nothing under `src/` imports it.
 */

import { contentId, elementId } from '../../src/core/ids.js';
import { defaultEmitOptions } from '../../src/core/contracts.js';

const CAPTURED_AT = '2026-02-01T09:00:00.000Z';

/**
 * @param {string} id
 * @param {number} beats  how many beats the scene has
 * @param {Partial<import('../../src/core/contracts.d.ts').Scene>} [overrides]
 * @returns {import('../../src/core/contracts.d.ts').Scene}
 */
export function scene(id, beats = 3, overrides = {}) {
  return {
    id,
    layout: 'splitBeforeAfter',
    headline: `Headline for ${id}`,
    subhead: null,
    specimenId: null,
    renditionIds: [],
    beats: Array.from({ length: beats }, (_, i) => ({
      id: `${id}_b${i}`,
      reveals: [elementId(id, `block/${i}`)],
      presenterNote: i === 0 ? `Open ${id} by naming the problem in their words.` : null,
      dwellHintMs: i === 0 ? 20000 : null,
    })),
    branchAnchors: [],
    ...overrides,
  };
}

/**
 * A scene with no reveals at all — the `contentsIndex` / `quoteCard` shape.
 * @param {string} id
 * @returns {import('../../src/core/contracts.d.ts').Scene}
 */
export function stillScene(id) {
  return {
    id,
    layout: 'quoteCard',
    headline: null,
    subhead: null,
    specimenId: null,
    renditionIds: [],
    beats: [{ id: `${id}_b0`, reveals: [], presenterNote: null, dwellHintMs: null }],
    branchAnchors: [],
  };
}

/**
 * @param {string} id
 * @param {string} objection
 * @param {import('../../src/core/contracts.d.ts').Scene[]} scenes
 * @param {'anchor'|'nextSpineScene'} [returnPolicy]
 * @param {string[]} [aliases]
 * @returns {import('../../src/core/contracts.d.ts').Branch}
 */
export function branch(id, objection, scenes, returnPolicy = 'anchor', aliases = []) {
  return { id, objection, aliases, scenes, returnPolicy };
}

/** @returns {import('../../src/core/contracts.d.ts').BrandSystem} */
export function brand(overrides = {}) {
  return {
    id: contentId('brand', 'fixture'),
    sourceUrl: null,
    capturedAt: CAPTURED_AT,
    colors: [
      { role: 'primary', hex: '#123A8C', oklch: [0.36, 0.14, 264], source: 'extracted', contrastWithPair: 10.2 },
      { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 10.2 },
      { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'extracted', contrastWithPair: 16.4 },
      { role: 'onSurface', hex: '#16181D', oklch: [0.22, 0.01, 264], source: 'extracted', contrastWithPair: 16.4 },
    ],
    faces: [
      { family: 'Inter', fallbackStack: ['Inter', 'Arial', 'sans-serif'], weightsSeen: [400, 600], role: 'body', metricDelta: { capHeight: 1.015, xHeight: 0.996, avgAdvance: 1.002 }, embeddable: false },
      { family: 'Inter', fallbackStack: ['Inter', 'Arial', 'sans-serif'], weightsSeen: [700], role: 'display', metricDelta: { capHeight: 1.015, xHeight: 0.996, avgAdvance: 1.002 }, embeddable: false },
    ],
    logos: [],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: 0.12 },
    confidence: { colors: 0.82, faces: 0.7, logos: 0.4, shape: 0.75, imagery: 0.6 },
    manualOverrides: [],
    ...overrides,
  };
}

/**
 * A complete proof: a five-scene spine with three branches, one of them nested
 * inside another, which is the shape §22.4 warns about.
 * @param {object} [options]
 * @param {number} [options.spineScenes]
 * @param {Partial<import('../../src/core/contracts.d.ts').EmitOptions>} [options.emitOptions]
 * @returns {import('../../src/core/contracts.d.ts').Proof}
 */
export function makeProof(options = {}) {
  const n = options.spineScenes ?? 5;
  const spine = Array.from({ length: n }, (_, i) => scene(`sc_spine_${i}`, i === 2 ? 1 : 3));

  const approvals = branch('bn_approvals', 'Our approvals process would never allow this', [
    scene('sc_appr_0', 2),
    scene('sc_appr_1', 2, { branchAnchors: ['bn_legal'] }),
  ], 'anchor', ['sign-off', 'review chain', 'legal review']);

  const legal = branch('bn_legal', 'Legal has to see every claim', [
    scene('sc_legal_0', 2),
  ], 'anchor', ['claims', 'compliance']);

  const scale = branch('bn_scale', 'That works for one page, not four hundred', [
    scene('sc_scale_0', 3),
    scene('sc_scale_1', 1),
  ], 'nextSpineScene', ['volume', 'at scale']);

  spine[1].branchAnchors = ['bn_approvals'];
  spine[3].branchAnchors = ['bn_scale'];

  return {
    schemaVersion: 1,
    id: contentId('proof', 'fixture'),
    prospectName: 'Northwind Industrial',
    createdAt: CAPTURED_AT,
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches: [approvals, legal, scale],
    emitOptions: { ...defaultEmitOptions(), ...(options.emitOptions || {}) },
  };
}

/** A proof with a single scene and no branches, for the smallest possible case. */
export function minimalProof() {
  return {
    schemaVersion: 1,
    id: contentId('proof', 'minimal'),
    prospectName: 'Solo',
    createdAt: CAPTURED_AT,
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine: [scene('sc_only', 1)],
    branches: [],
    emitOptions: defaultEmitOptions(),
  };
}
