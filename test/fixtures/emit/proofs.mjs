/**
 * Proof fixtures for the emitter's tests.
 *
 * Everything here is deterministic: ids are content-derived, images are
 * generated pixel-by-pixel from a seeded formula and encoded with the in-repo
 * PNG encoder, and no value comes from a clock. Two calls with the same
 * arguments produce byte-identical proofs, which is what makes §17.6's
 * byte-identical re-emit assertion mean something.
 */

import { contentId, elementId } from '../../../src/core/ids.js';
import { defaultEmitOptions } from '../../../src/core/contracts.js';
import { base64Encode } from '../../../src/core/bytes.js';
import { encodePng } from '../../../src/emit/png.js';
import { Pcg32 } from '../../../src/core/prng.js';
import { promoteProvenance } from '../../../src/recipe/index.js';

const CAPTURED_AT = '2026-02-01T09:00:00.000Z';

/**
 * A deterministic PNG of a given size. Noise makes it incompressible enough
 * that downscaling produces a real, measurable saving.
 * @param {number} w
 * @param {number} h
 * @param {number} seed
 * @returns {string} a data URI
 */
export function pngDataUri(w, h, seed = 7) {
  const rng = new Pcg32(seed, 1);
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = (x * 3 + rng.nextInt(64)) & 255;
      rgba[o + 1] = (y * 5 + rng.nextInt(64)) & 255;
      rgba[o + 2] = ((x ^ y) * 2 + rng.nextInt(64)) & 255;
      rgba[o + 3] = 255;
    }
  }
  return `data:image/png;base64,${base64Encode(encodePng({ width: w, height: h, rgba }))}`;
}

/**
 * @param {string} id
 * @param {number} w
 * @param {number} h
 * @param {number} seed
 * @returns {import('../../../src/core/contracts.d.ts').MediaRef}
 */
export function media(id, w, h, seed) {
  const dataUri = pngDataUri(w, h, seed);
  return { id, dataUri, alt: `figure ${id}`, intrinsic: { w, h }, bytes: Math.floor((dataUri.length * 3) / 4) };
}

/** @returns {import('../../../src/core/contracts.d.ts').BrandSystem} */
export function brand(overrides = {}) {
  return {
    id: contentId('brand', 'emit-fixture'),
    sourceUrl: null,
    capturedAt: CAPTURED_AT,
    colors: [
      { role: 'primary', hex: '#123A8C', oklch: [0.36, 0.14, 264], source: 'extracted', contrastWithPair: 10.2 },
      { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 10.2 },
      { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'extracted', contrastWithPair: 16.4 },
      { role: 'onSurface', hex: '#16181D', oklch: [0.22, 0.01, 264], source: 'extracted', contrastWithPair: 16.4 },
      { role: 'surfaceAlt', hex: '#F4F5F7', oklch: [0.96, 0.004, 264], source: 'derived', contrastWithPair: 15.1 },
      { role: 'onSurfaceAlt', hex: '#16181D', oklch: [0.22, 0.01, 264], source: 'derived', contrastWithPair: 15.1 },
      { role: 'accent', hex: '#2F5BD8', oklch: [0.52, 0.19, 264], source: 'extracted', contrastWithPair: 5.4 },
      { role: 'onAccent', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 5.4 },
      { role: 'border', hex: '#D9DCE1', oklch: [0.89, 0.006, 264], source: 'derived', contrastWithPair: null },
      { role: 'success', hex: '#17693F', oklch: [0.48, 0.11, 155], source: 'derived', contrastWithPair: null },
      { role: 'warning', hex: '#8A5A00', oklch: [0.52, 0.11, 76], source: 'derived', contrastWithPair: null },
      { role: 'danger', hex: '#A32020', oklch: [0.47, 0.18, 27], source: 'derived', contrastWithPair: null },
    ],
    faces: [
      { family: 'Inter', fallbackStack: ['Inter', 'Arial', 'sans-serif'], weightsSeen: [400, 600], role: 'body', metricDelta: { capHeight: 1.015, xHeight: 0.996, avgAdvance: 1.002 }, embeddable: false },
      { family: 'Inter Display', fallbackStack: ['Inter', 'Arial', 'sans-serif'], weightsSeen: [700], role: 'display', metricDelta: { capHeight: 1.015, xHeight: 0.996, avgAdvance: 1.002 }, embeddable: false },
    ],
    logos: [{
      id: contentId('logo', 'emit-fixture'),
      kind: 'svg',
      data: 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%2032%22%3E%3Crect%20width%3D%22120%22%20height%3D%2232%22%20fill%3D%22%23123A8C%22%2F%3E%3C%2Fsvg%3E',
      variant: 'primary',
      intrinsic: { w: 120, h: 32 },
      hasTransparency: false,
    }],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: 0.12 },
    confidence: { colors: 0.82, faces: 0.7, logos: 0.6, shape: 0.75, imagery: 0.6 },
    manualOverrides: [],
    ...overrides,
  };
}

/**
 * @param {string} id
 * @param {import('../../../src/core/contracts.d.ts').MediaRef[]} mediaRefs
 * @returns {import('../../../src/core/contracts.d.ts').Specimen}
 */
export function specimen(id, mediaRefs = []) {
  return {
    id,
    kind: 'page',
    title: `Northwind — ${id}`,
    sourceUrl: 'https://northwind.example/products/valve-assembly',
    capturedAt: CAPTURED_AT,
    blocks: [
      { type: 'heading', level: 1, text: 'Precision valve assemblies for continuous process plant' },
      { type: 'paragraph', text: 'Northwind builds flow-control hardware for refineries and chemical works. Every assembly ships with a material certificate and a pressure-test record.' },
      ...mediaRefs.map((m) => ({ type: 'media', ref: m.id, caption: 'Valve assembly, cutaway' })),
      { type: 'cta', label: 'Request a quotation', href: 'https://northwind.example/contact' },
    ],
    media: mediaRefs,
    meta: { lang: 'en', description: 'Flow control hardware' },
    wordCount: 41,
    locale: 'en-GB',
  };
}

/**
 * @param {string} id
 * @param {string} specimenId
 * @param {import('../../../src/core/contracts.d.ts').Provenance} provenance
 * @param {object} [extra]
 * @returns {import('../../../src/core/contracts.d.ts').Rendition}
 */
export function rendition(id, specimenId, provenance, extra = {}) {
  return {
    id,
    specimenId,
    recipeId: 'rc_locale_fanout',
    label: extra.label || 'de-DE',
    blocks: [{ type: 'paragraph', text: 'Präzisionsventilbaugruppen für kontinuierliche Prozessanlagen.' }],
    media: extra.media || [],
    provenance,
    producedBy: extra.producedBy || 'manual-paste',
    notes: extra.notes === undefined ? null : extra.notes,
  };
}

/**
 * @param {string} id
 * @param {object} [options]
 * @returns {import('../../../src/core/contracts.d.ts').Scene}
 */
export function scene(id, options = {}) {
  const blockCount = options.blockCount ?? 3;
  const renditionIds = options.renditionIds || [];
  const reveals = [];
  for (let i = 0; i < blockCount; i++) reveals.push([elementId(id, `before/block/${i}`)]);
  renditionIds.forEach((_, i) => reveals.push([elementId(id, `after/${i}`)]));
  if (reveals.length === 0) reveals.push([elementId(id, 'headline')]);

  return {
    id,
    layout: options.layout || 'splitBeforeAfter',
    headline: options.headline === undefined ? `What ${id} proves` : options.headline,
    subhead: null,
    specimenId: options.specimenId || null,
    renditionIds,
    beats: reveals.map((r, i) => ({
      id: `${id}_b${i}`,
      reveals: r,
      presenterNote: i === 0 ? `Open ${id} in their words, not ours.` : null,
      dwellHintMs: i === 0 ? 20000 : null,
    })),
    branchAnchors: options.branchAnchors || [],
  };
}

/**
 * The main fixture: two specimens with media, four renditions covering every
 * provenance value, a four-scene spine and two branches, one nested.
 *
 * @param {object} [options]
 * @param {Partial<import('../../../src/core/contracts.d.ts').EmitOptions>} [options.emitOptions]
 * @param {number} [options.imageEdge]
 * @param {import('../../../src/core/contracts.d.ts').Provenance} [options.verifiedProvenance]
 * @param {string|null} [options.promotionNote]
 * @returns {import('../../../src/core/contracts.d.ts').Proof}
 */
export function emitProof(options = {}) {
  const edge = options.imageEdge ?? 48;
  const m1 = media(contentId('media', 'hero'), edge, edge, 11);
  const m2 = media(contentId('media', 'detail'), Math.round(edge * 0.75), Math.round(edge * 0.75), 23);
  const m3 = media(contentId('media', 'rendition'), Math.round(edge * 0.5), Math.round(edge * 0.5), 37);

  const sp1 = specimen(contentId('specimen', 'pdp'), [m1, m2]);
  const sp2 = specimen(contentId('specimen', 'article'), []);

  const rdIllustrative = rendition(contentId('rendition', 'illustrative'), sp1.id, 'illustrative', {
    label: 'de-DE', producedBy: 'adapter', media: [m3],
  });
  const rdClient = rendition(contentId('rendition', 'client'), sp1.id, 'client-supplied', { label: 'Email variant' });
  // A real promotion, written by L7's `promoteProvenance` — the only route to
  // `verified-by-user` (§9). `options.promotionNote` replaces it with whatever
  // an attacker would try instead, which is what the §22.6 tests need.
  const rdVerified = options.promotionNote === undefined
    ? promoteProvenance(
      rendition(contentId('rendition', 'verified'), sp2.id, 'illustrative', { label: 'PDP module' }),
      { by: 't.douglass@northwind.example', at: '2026-02-14T10:12:00.000Z' },
    )
    : rendition(contentId('rendition', 'verified'), sp2.id, options.verifiedProvenance || 'verified-by-user', {
      label: 'PDP module',
      notes: options.promotionNote,
    });
  const rdTemplate = rendition(contentId('rendition', 'template'), sp2.id, 'illustrative', {
    label: 'SMS', producedBy: 'template',
  });

  const spine = [
    scene('sc_spine_0', { specimenId: sp1.id, blockCount: 4 }),
    scene('sc_spine_1', { specimenId: sp1.id, blockCount: 4, renditionIds: [rdIllustrative.id, rdClient.id], branchAnchors: ['bn_approvals'] }),
    scene('sc_spine_2', { specimenId: sp2.id, blockCount: 2, renditionIds: [rdVerified.id], layout: 'fanOut' }),
    scene('sc_spine_3', { specimenId: null, blockCount: 0, layout: 'quoteCard', branchAnchors: ['bn_scale'] }),
  ];

  const approvals = {
    id: 'bn_approvals',
    objection: 'Our approvals process would never allow this',
    aliases: ['sign-off', 'review chain', 'legal review', 'approvals'],
    scenes: [
      scene('sc_appr_0', { specimenId: sp2.id, blockCount: 2, renditionIds: [rdTemplate.id], layout: 'approvalChainLayoutMissing' in options ? 'stack' : 'stack' }),
      scene('sc_appr_1', { specimenId: null, blockCount: 1, layout: 'systemMap', branchAnchors: ['bn_scale'] }),
    ],
    returnPolicy: 'anchor',
  };
  const scale = {
    id: 'bn_scale',
    objection: 'That works for one page, not four hundred',
    aliases: ['volume', 'at scale'],
    scenes: [scene('sc_scale_0', { specimenId: sp1.id, blockCount: 3, layout: 'fullBleed' })],
    returnPolicy: 'nextSpineScene',
  };

  return {
    schemaVersion: 1,
    id: contentId('proof', 'emit-fixture'),
    prospectName: 'Northwind Industrial',
    createdAt: CAPTURED_AT,
    brand: brand(),
    specimens: [sp1, sp2],
    renditions: [rdIllustrative, rdClient, rdVerified, rdTemplate],
    recipes: [{ id: 'rc_locale_fanout', name: 'Locale fan-out', intent: 'Nine markets, not nine translations.', inputKinds: ['page'], outputLabels: ['de-DE'], adapterPrompt: null }],
    spine,
    branches: [approvals, scale],
    emitOptions: { ...defaultEmitOptions(), ...(options.emitOptions || {}) },
  };
}

/** The smallest proof that still exercises the emitter end to end. */
export function tinyProof(overrides = {}) {
  return {
    schemaVersion: 1,
    id: contentId('proof', 'emit-tiny'),
    prospectName: 'Solo',
    createdAt: CAPTURED_AT,
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine: [scene('sc_only', { blockCount: 0 })],
    branches: [],
    emitOptions: defaultEmitOptions(),
    ...overrides,
  };
}
