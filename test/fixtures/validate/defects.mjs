/**
 * Proofs with exactly one class of defect planted in each.
 *
 * §14 asks for fourteen rules; this fixture gives each of them a positive case
 * and lets every other rule act as the negative case for it, because a defect
 * planted here must be the *only* thing preflight reports. `cleanProof()` is the
 * shared control: a complete, contract-valid, presentable proof that produces no
 * findings at all. If a rule fires on it, that rule has a false positive, and
 * the test says so by name.
 *
 * Every value is deterministic. Ids are content-derived, `capturedAt` is fixed,
 * and the clock is injected — a proof built twice is the same proof (§5).
 */

import { contentId, elementId } from '../../../src/core/ids.js';
import { defaultEmitOptions } from '../../../src/core/contracts.js';

/** The instant every fixture is captured at, and the instant preflight is run at. */
export const CAPTURED_AT = '2026-02-01T09:00:00.000Z';
/** Eight days later: inside the §6 30-day window. */
export const NOW = '2026-02-09T09:00:00.000Z';
/** Ten months later: well outside it. */
export const MUCH_LATER = '2026-12-01T09:00:00.000Z';

/** A 1×1 transparent PNG, the smallest legal data URI. */
export const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * A palette in which every pair clears the minimum it is held to: the five
 * foreground roles at 4.5:1, the brand colours as display text at 3:1, and the
 * border and status colours at the 3:1 non-text minimum.
 */
export const COMPLIANT_COLORS = [
  { role: 'primary', hex: '#123A8C', oklch: [0.353, 0.152, 265.6], source: 'extracted', contrastWithPair: 10.45 },
  { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 10.45 },
  { role: 'secondary', hex: '#1F4E9C', oklch: [0.432, 0.147, 262.4], source: 'extracted', contrastWithPair: 7.99 },
  { role: 'onSecondary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 7.99 },
  { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'extracted', contrastWithPair: 17.76 },
  { role: 'onSurface', hex: '#16181D', oklch: [0.213, 0.011, 264.5], source: 'extracted', contrastWithPair: 17.76 },
  { role: 'surfaceAlt', hex: '#F2F4F8', oklch: [0.963, 0.006, 259.2], source: 'derived', contrastWithPair: 13.58 },
  { role: 'onSurfaceAlt', hex: '#24272E', oklch: [0.281, 0.012, 264.9], source: 'derived', contrastWithPair: 13.58 },
  { role: 'accent', hex: '#8A2540', oklch: [0.412, 0.145, 9.2], source: 'extracted', contrastWithPair: 8.68 },
  { role: 'onAccent', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 8.68 },
  { role: 'border', hex: '#767D89', oklch: [0.577, 0.02, 258.1], source: 'derived', contrastWithPair: 4.15 },
  { role: 'success', hex: '#1F7A3D', oklch: [0.512, 0.132, 148.6], source: 'derived', contrastWithPair: 5.37 },
  { role: 'warning', hex: '#8A5A00', oklch: [0.503, 0.108, 76.4], source: 'derived', contrastWithPair: 5.93 },
  { role: 'danger', hex: '#B3261E', oklch: [0.494, 0.185, 28.5], source: 'derived', contrastWithPair: 6.54 },
];

/**
 * Faces the artifact can actually render. Arial is a system family, so nothing
 * substitutes and `FONT_UNAVAILABLE` has nothing to say — which is what makes it
 * the right control.
 */
export const AVAILABLE_FACES = [
  { family: 'Arial', fallbackStack: ['Arial', 'Helvetica', 'sans-serif'], weightsSeen: [400, 600], role: 'body', metricDelta: { capHeight: 1, xHeight: 1, avgAdvance: 1 }, embeddable: false },
  { family: 'Arial', fallbackStack: ['Arial', 'Helvetica', 'sans-serif'], weightsSeen: [700], role: 'display', metricDelta: { capHeight: 1, xHeight: 1, avgAdvance: 1 }, embeddable: false },
];

/** @param {object} [overrides] */
export function brand(overrides = {}) {
  return {
    id: contentId('brand', 'validate-fixture'),
    sourceUrl: null,
    capturedAt: CAPTURED_AT,
    colors: COMPLIANT_COLORS.map((c) => ({ ...c })),
    faces: AVAILABLE_FACES.map((f) => ({ ...f, fallbackStack: f.fallbackStack.slice(), weightsSeen: f.weightsSeen.slice() })),
    logos: [{
      id: 'lg_primary',
      kind: 'svg',
      data: '<svg viewBox="0 0 24 24" width="24" height="24"><rect width="24" height="24" fill="#123A8C"/></svg>',
      variant: 'primary',
      intrinsic: { w: 24, h: 24 },
      hasTransparency: false,
    }],
    shape: { radiusPx: 8, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: 0.1 },
    confidence: { colors: 0.9, faces: 0.85, logos: 0.7, shape: 0.8, imagery: 0.7 },
    manualOverrides: [],
    ...overrides,
  };
}

/**
 * A specimen with short copy. Short matters: the stand-in scene measurement
 * gives a real container, and copy that fits is what makes this a control rather
 * than an overflow fixture.
 * @param {object} [overrides]
 */
export function specimen(overrides = {}) {
  const blocks = overrides.blocks || [
    { type: 'heading', level: 1, text: 'Market launch' },
    { type: 'paragraph', text: 'One brief. Nine markets.' },
  ];
  return {
    id: 'sp_home',
    kind: 'page',
    title: 'Home page',
    sourceUrl: null,
    capturedAt: CAPTURED_AT,
    blocks,
    media: [{ id: 'md_hero', dataUri: TINY_PNG, alt: 'Hero', intrinsic: { w: 1200, h: 630 }, bytes: 68 }],
    meta: { lang: 'en' },
    wordCount: 7,
    locale: 'en',
    ...overrides,
  };
}

/** @param {object} [overrides] */
export function rendition(overrides = {}) {
  return {
    id: 'rd_de',
    specimenId: 'sp_home',
    recipeId: 'rc_locale',
    label: 'de-DE',
    blocks: [
      { type: 'heading', level: 1, text: 'Markteinführung' },
      { type: 'paragraph', text: 'Ein Briefing. Neun Märkte.' },
    ],
    media: [],
    provenance: 'client-supplied',
    producedBy: 'manual-paste',
    notes: null,
    ...overrides,
  };
}

/**
 * @param {string} id
 * @param {number} beats
 * @param {object} [overrides]
 */
export function scene(id, beats = 2, overrides = {}) {
  return {
    id,
    layout: 'splitBeforeAfter',
    headline: overrides.headline !== undefined ? overrides.headline : `Point ${id.slice(-1)}`,
    subhead: null,
    specimenId: 'sp_home',
    renditionIds: ['rd_de'],
    beats: Array.from({ length: beats }, (_, i) => ({
      id: `${id}_b${i}`,
      reveals: [elementId(id, `block/${i}`)],
      presenterNote: i === 0 ? `Open ${id} in their words.` : null,
      dwellHintMs: null,
    })),
    branchAnchors: [],
    ...overrides,
  };
}

/**
 * A complete, presentable proof with no defects at all. Every rule must be
 * silent on it.
 * @param {object} [overrides]
 */
export function cleanProof(overrides = {}) {
  const spine = [scene('sc_a', 2), scene('sc_b', 2), scene('sc_c', 1)];
  spine[1].branchAnchors = ['bn_approvals'];
  const branches = [{
    id: 'bn_approvals',
    objection: 'Our approvals process would never allow this',
    aliases: ['sign-off', 'review chain'],
    scenes: [scene('sc_ap0', 2, { headline: 'Approval chain' })],
    returnPolicy: 'anchor',
  }];
  return {
    schemaVersion: 1,
    id: contentId('proof', 'validate-clean'),
    prospectName: 'Northwind Industrial',
    createdAt: CAPTURED_AT,
    brand: brand(),
    specimens: [specimen()],
    renditions: [rendition()],
    recipes: [{
      id: 'rc_locale',
      name: 'locale-fanout',
      intent: 'One page, nine markets, structured for each.',
      inputKinds: ['page'],
      outputLabels: ['de-DE'],
      adapterPrompt: null,
    }],
    spine,
    branches,
    emitOptions: defaultEmitOptions(),
    ...overrides,
  };
}

/**
 * Deep-clone helper so a defect builder can mutate freely without touching the
 * control.
 * @template T @param {T} v @returns {T}
 */
export function copy(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * A proof carrying exactly one class of defect.
 *
 * @param {'ASSET_MISSING'|'ASSET_OVERSIZE'|'FONT_UNAVAILABLE'|'TEXT_OVERFLOW'
 *   |'CONTRAST_FAIL'|'BRANCH_UNREACHABLE'|'BRANCH_NO_RETURN'|'BEAT_EMPTY'
 *   |'PROVENANCE_UNLABELED'|'NETWORK_REFERENCE'|'STALE_CAPTURE'|'SPECIMEN_EMPTY'
 *   |'DUPLICATE_SCENE'|'SIZE_BUDGET_EXCEEDED'} code
 * @returns {any}
 */
export function defectProof(code) {
  const p = copy(cleanProof());
  switch (code) {
    case 'ASSET_MISSING':
      p.specimens[0].blocks.push({ type: 'media', ref: 'md_nowhere', caption: 'The hero shot' });
      return p;

    case 'ASSET_OVERSIZE':
      p.specimens[0].media[0].bytes = 9_000_000;
      p.specimens[0].media[0].intrinsic = { w: 4000, h: 3000 };
      return p;

    case 'FONT_UNAVAILABLE':
      p.brand.faces[1].family = 'Recursive Display';
      p.brand.faces[1].fallbackStack = ['Recursive Display', 'Arial', 'sans-serif'];
      return p;

    case 'TEXT_OVERFLOW':
      // A headline no container at `sm` can hold, in a face that substitutes.
      p.brand.faces[1].family = 'Montserrat';
      p.brand.faces[1].fallbackStack = ['Montserrat', 'Verdana', 'sans-serif'];
      p.spine[0].headline = 'Every single market launch, entirely on brand, assembled and reviewed in one afternoon, without a single rebuild';
      return p;

    case 'CONTRAST_FAIL':
      // A near-white primary with white text on it: §22.1's canonical hostile palette.
      p.brand.colors.find((c) => c.role === 'primary').hex = '#EDEFF5';
      p.brand.colors.find((c) => c.role === 'primary').contrastWithPair = 1.16;
      p.brand.colors.find((c) => c.role === 'onPrimary').contrastWithPair = 1.16;
      return p;

    case 'BRANCH_UNREACHABLE':
      p.branches.push({
        id: 'bn_orphan',
        objection: '',
        aliases: [],
        scenes: [scene('sc_orphan', 1, { headline: 'Nobody can get here' })],
        returnPolicy: 'nextSpineScene',
      });
      return p;

    case 'BRANCH_NO_RETURN':
      p.branches.push({
        id: 'bn_deadend',
        objection: 'That only works for one page',
        aliases: ['at scale'],
        scenes: [scene('sc_dead', 1, { headline: 'No way back' })],
        returnPolicy: 'anchor',   // and nothing anchors it
      });
      return p;

    case 'BEAT_EMPTY':
      p.spine[0].beats.splice(1, 0, { id: 'sc_a_bdead', reveals: [], presenterNote: null, dwellHintMs: null });
      return p;

    case 'PROVENANCE_UNLABELED':
      p.renditions[0].provenance = 'verified-by-user';
      p.renditions[0].producedBy = 'adapter';
      p.renditions[0].notes = 'Pasted from the adapter output.';
      return p;

    case 'NETWORK_REFERENCE':
      p.specimens[0].blocks.push({
        type: 'raw',
        html: '<p>Tracked</p><img src="https://analytics.example.invalid/pixel.gif" width="1" height="1">',
      });
      return p;

    case 'STALE_CAPTURE':
      p.specimens[0].capturedAt = '2025-11-01T09:00:00.000Z';
      return p;

    case 'SPECIMEN_EMPTY':
      p.specimens.push({
        id: 'sp_blank',
        kind: 'article',
        title: 'The article that captured as nothing',
        sourceUrl: null,
        capturedAt: CAPTURED_AT,
        blocks: [],
        media: [],
        meta: {},
        wordCount: 0,
        locale: 'en',
      });
      p.spine[2].specimenId = 'sp_blank';
      return p;

    case 'DUPLICATE_SCENE':
      p.branches[0].scenes.push(copy(p.spine[0]));
      return p;

    case 'SIZE_BUDGET_EXCEEDED':
      p.emitOptions.maxBytes = 400_000;
      p.specimens[0].media.push({
        id: 'md_big', dataUri: TINY_PNG, alt: null, intrinsic: { w: 2000, h: 1200 }, bytes: 3_000_000,
      });
      return p;

    default:
      throw new Error(`defectProof: no fixture for ${code}`);
  }
}

/** A rendered document and stylesheet for the rules that need one. */
export const CLEAN_DOCUMENT = {
  html: '<div class="pp-scene" data-pp-scene="sc_a"><p class="pp-provenance">Illustrative</p></div>',
  css: '.pp-provenance{font-size:12px;color:#24272E;background:#F2F4F8}',
};

/** A document carrying a planted network reference, for the emit-side scan. */
export const LEAKY_DOCUMENT = {
  html: '<div class="pp-scene"><script src="https://cdn.example.invalid/analytics.js"></script></div>',
  css: '@import url("https://fonts.example.invalid/inter.css");',
};
