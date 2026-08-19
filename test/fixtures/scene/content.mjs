/**
 * Realistic scene fixtures: one captured page and the renditions a real pitch
 * would put beside it.
 *
 * The specimen is shaped like what §8's capture actually produces from an
 * enterprise page — a headline, prose, a spec list, a comparison table, a hero
 * image and a call to action — because a layout that only ever sees three
 * paragraphs in test is a layout that breaks the first time it meets a table.
 *
 * Provenance is deliberately mixed: illustrative renditions (the default under
 * §9), one the client supplied, and one promoted to verified-by-user, so the
 * labelling law is exercised in every direction.
 */

import { contentId, elementId as elementIdFor } from '../../../src/core/ids.js';
import { countWords } from '../../../src/core/contracts.js';

const CAPTURED_AT = '2026-02-01T09:00:00.000Z';

/** A 1x1 transparent PNG — the smallest thing that is genuinely a data URI. */
export const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** @returns {import('../../../src/core/contracts.d.ts').MediaRef} */
export function heroMedia() {
  return {
    id: 'md_hero',
    dataUri: PIXEL,
    alt: 'A conveyor line in a Northwind distribution centre',
    intrinsic: { w: 2400, h: 1350 },
    bytes: 68,
  };
}

/**
 * A media reference the artifact cannot show — the `ASSET_MISSING` shape. Its
 * URI is deliberately not a `data:` URI, which is the only kind a layout will
 * render (§13).
 * @returns {import('../../../src/core/contracts.d.ts').MediaRef}
 */
export function brokenMedia() {
  return {
    id: 'md_broken',
    dataUri: 'blob:not-inlined',
    alt: 'A diagram that was not inlined at emit time',
    intrinsic: { w: 800, h: 600 },
    bytes: 0,
  };
}

/** @returns {import('../../../src/core/contracts.d.ts').ContentBlock[]} */
export function sourceBlocks() {
  return [
    { type: 'heading', level: 1, text: 'Conveyor drive units built for continuous duty' },
    { type: 'paragraph', text: 'Northwind drive units are specified for distribution centres running three shifts a day, seven days a week, in ambient temperatures from minus twenty to plus fifty degrees Celsius. Every unit ships with the service record of the line it was tested on.' },
    { type: 'media', ref: 'md_hero', caption: 'A Northwind drive unit on the test line at Gateshead' },
    { type: 'heading', level: 2, text: 'Specification' },
    {
      type: 'list',
      ordered: false,
      items: [
        'Continuous torque from 40 to 1,600 newton metres',
        'IP66 sealed housing, stainless fasteners throughout',
        'Field-replaceable bearing cartridge, no special tooling',
        'Condition monitoring over Modbus TCP or a dry contact',
        'Spares held in three regional depots',
      ],
    },
    {
      type: 'table',
      header: true,
      rows: [
        ['Model', 'Torque (Nm)', 'Frame', 'Lead time'],
        ['ND-40', '40', '71', '2 weeks'],
        ['ND-180', '180', '100', '3 weeks'],
        ['ND-640', '640', '132', '6 weeks'],
        ['ND-1600', '1,600', '180', '10 weeks'],
      ],
    },
    { type: 'quote', text: 'We stopped keeping a spare motor on every line the year we changed over.', attribution: 'Maintenance lead, national grocery DC' },
    // A captured `<pre>`: `ContentBlock.pre` (API.md Part 3b). The columns are
    // lined up with spaces, which is the whole reason the prospect wrote it
    // inside a `<pre>` and the reason a layout that renders it in a
    // proportional face with `white-space: normal` has lost the content.
    {
      type: 'paragraph',
      pre: true,
      text: 'drive = studio.unit("ND-640")\n'
        + 'drive.autotune(step=2.5, timeout=600)\n'
        + 'drive.commit()\n'
        + '# step     2.5   torque ramp increment, Nm\n'
        + '# timeout  600   seconds before the run gives up',
    },
    { type: 'heading', level: 3, text: 'Ordering' },
    { type: 'paragraph', text: 'Configure a unit against your existing gearbox flange, or send us the drawing and we will confirm the fit before you order.' },
    { type: 'cta', label: 'Request a fit check', href: null },
    { type: 'raw', html: '<div class="legacy-widget"><p>Stock availability updates every fifteen minutes.</p></div>' },
  ];
}

/**
 * @param {Partial<import('../../../src/core/contracts.d.ts').Specimen>} [overrides]
 * @returns {import('../../../src/core/contracts.d.ts').Specimen}
 */
export function specimen(overrides = {}) {
  const blocks = overrides.blocks || sourceBlocks();
  return {
    id: contentId('specimen', 'northwind-pdp'),
    kind: 'product',
    title: 'Conveyor drive units | Northwind Industrial',
    sourceUrl: 'https://www.northwind-industrial.example/products/conveyor-drive-units',
    capturedAt: CAPTURED_AT,
    blocks,
    media: [heroMedia(), brokenMedia()],
    meta: { lang: 'en-GB', description: 'Continuous-duty conveyor drive units' },
    wordCount: countWords(blocks),
    locale: 'en-GB',
    ...overrides,
  };
}

/**
 * @param {object} spec
 * @returns {import('../../../src/core/contracts.d.ts').Rendition}
 */
export function rendition(spec) {
  return {
    id: spec.id || contentId('rendition', spec.label),
    specimenId: spec.specimenId || contentId('specimen', 'northwind-pdp'),
    recipeId: spec.recipeId || 'rc_locale_fanout',
    label: spec.label,
    blocks: spec.blocks || [],
    media: spec.media || [],
    provenance: spec.provenance || 'illustrative',
    producedBy: spec.producedBy || 'manual-paste',
    notes: spec.notes === undefined ? null : spec.notes,
  };
}

/**
 * Nine market renditions — the `locale-fanout` recipe's output shape. Every one
 * is illustrative, which is the default §9 requires and the case the labelling
 * law exists for.
 * @param {number} [count]
 * @returns {import('../../../src/core/contracts.d.ts').Rendition[]}
 */
export function localeFanout(count = 9) {
  const markets = [
    ['de-DE', 'Förderband-Antriebseinheiten für den Dauerbetrieb', 'Antriebseinheiten von Northwind sind für Distributionszentren im Dreischichtbetrieb ausgelegt.'],
    ['fr-FR', 'Motoréducteurs de convoyeur pour service continu', 'Les motoréducteurs Northwind sont spécifiés pour des centres de distribution fonctionnant en trois-huit.'],
    ['ja-JP', '連続運転向けコンベヤ駆動ユニット', 'ノースウィンドの駆動ユニットは、一日三交代で稼働する物流センター向けに設計されています。'],
    ['es-MX', 'Unidades motrices para transportadores de servicio continuo', 'Las unidades Northwind están especificadas para centros de distribución que operan tres turnos.'],
    ['pt-BR', 'Unidades de acionamento para transportadores', 'As unidades Northwind são especificadas para centros de distribuição em três turnos.'],
    ['nl-NL', 'Aandrijfeenheden voor transportbanden', 'Northwind-aandrijfeenheden zijn ontworpen voor distributiecentra die in drie ploegen draaien.'],
    ['pl-PL', 'Jednostki napędowe przenośników do pracy ciągłej', 'Jednostki Northwind są przeznaczone dla centrów dystrybucyjnych pracujących na trzy zmiany.'],
    ['it-IT', 'Unità di azionamento per nastri trasportatori', 'Le unità Northwind sono specificate per centri di distribuzione su tre turni.'],
    ['sv-SE', 'Drivenheter för transportband i kontinuerlig drift', 'Northwinds drivenheter är specificerade för distributionscentraler som körs i tre skift.'],
  ];
  return markets.slice(0, count).map(([label, heading, paragraph]) => rendition({
    id: `rd_locale_${label.replace('-', '_')}`,
    label,
    recipeId: 'rc_locale_fanout',
    blocks: [
      { type: 'heading', level: 1, text: heading },
      { type: 'paragraph', text: paragraph },
      {
        type: 'list',
        ordered: false,
        items: ['40 – 1 600 Nm', 'IP66', 'Modbus TCP'],
      },
      { type: 'cta', label: 'Anfrage senden', href: null },
    ],
    provenance: 'illustrative',
  }));
}

/**
 * Channel variants, with one client-supplied and one promoted — so a scene can
 * show all three provenance states side by side.
 * @returns {import('../../../src/core/contracts.d.ts').Rendition[]}
 */
export function channelVariants() {
  return [
    rendition({
      id: 'rd_email',
      label: 'Email',
      recipeId: 'rc_channel_variants',
      blocks: [
        { type: 'heading', level: 1, text: 'Your line does not have to stop for a drive unit' },
        { type: 'paragraph', text: 'Field-replaceable bearing cartridges, spares in three depots, and a service record with every unit.' },
        { type: 'cta', label: 'Book a fit check', href: null },
      ],
      provenance: 'illustrative',
      producedBy: 'adapter',
      notes: 'Subject line held to 48 characters for the client’s ESP.',
    }),
    rendition({
      id: 'rd_paid_social',
      label: 'Paid social',
      recipeId: 'rc_channel_variants',
      blocks: [
        { type: 'heading', level: 1, text: 'Continuous duty. Three shifts. No spare motor on the shelf.' },
        { type: 'paragraph', text: 'Northwind drive units, specified for distribution centres.' },
      ],
      provenance: 'client-supplied',
      producedBy: 'manual-paste',
      notes: 'Supplied by the client’s brand team.',
    }),
    rendition({
      id: 'rd_in_product',
      label: 'In-product message',
      recipeId: 'rc_channel_variants',
      blocks: [
        { type: 'heading', level: 2, text: 'Drive unit ND-180 is due for a bearing service' },
        { type: 'paragraph', text: 'Order the cartridge from the parts list on this line.' },
      ],
      provenance: 'verified-by-user',
      producedBy: 'manual-paste',
      notes: 'promoted: verified by t.douglass on 2026-02-03T10:00:00.000Z',
    }),
  ];
}

/**
 * The approval chain shape for `stack`: the same asset at each review state.
 * @returns {import('../../../src/core/contracts.d.ts').Rendition[]}
 */
export function approvalChain() {
  const states = [
    ['Draft', 'Conveyor drive units built for continuous duty', 'First pass against the brief, brand rules applied automatically.'],
    ['Brand review', 'Conveyor drive units built for continuous duty', 'Type scale corrected; claim about temperature range left for legal.'],
    ['Legal review', 'Conveyor drive units for continuous duty', 'Temperature claim qualified to match the datasheet.'],
    ['Approved', 'Conveyor drive units for continuous duty', 'Signed off for the DACH launch.'],
  ];
  return states.map(([label, heading, paragraph], i) => rendition({
    id: `rd_state_${i}`,
    label,
    recipeId: 'rc_approval_chain',
    blocks: [
      { type: 'heading', level: 2, text: heading },
      { type: 'paragraph', text: paragraph },
    ],
    provenance: i === states.length - 1 ? 'verified-by-user' : 'illustrative',
    notes: null,
  }));
}

/**
 * A rendition carrying its own hero image, for `fullBleed`.
 * @returns {import('../../../src/core/contracts.d.ts').Rendition}
 */
export function heroRendition() {
  return rendition({
    id: 'rd_hero',
    label: 'Campaign hero, DACH',
    recipeId: 'rc_brief_to_asset',
    blocks: [
      { type: 'media', ref: 'md_hero_rendition', caption: 'Hero assembled from the client’s own component library' },
      { type: 'paragraph', text: 'Assembled from the design system at three breakpoints.' },
    ],
    media: [{ id: 'md_hero_rendition', dataUri: PIXEL, alt: 'Campaign hero', intrinsic: { w: 1600, h: 900 }, bytes: 68 }],
    provenance: 'illustrative',
  });
}

/**
 * A layout context for a scene, with everything the runtime would supply.
 * @param {import('../../../src/core/contracts.d.ts').Scene} scene
 * @param {object} [options]
 * @returns {import('../../../src/runtime/layouts.js').LayoutContext}
 */
export function contextFor(scene, options = {}) {
  const spec = options.specimen === undefined ? specimen() : options.specimen;
  const rends = options.renditions || [];
  /** @type {Map<string, import('../../../src/core/contracts.d.ts').MediaRef>} */
  const media = new Map();
  for (const m of (spec ? spec.media : [])) media.set(m.id, m);
  for (const r of rends) for (const m of (r.media || [])) media.set(m.id, m);
  return {
    scene,
    brand: options.brand === undefined ? brandFixture() : options.brand,
    specimen: spec,
    renditions: rends,
    media,
    el: options.el || ((path) => elementIdFor(scene.id, path)),
    labelIllustrative: options.labelIllustrative !== false,
    mode: options.mode || 'presenter',
  };
}

/**
 * A brand with a real type system, so measurement is not measuring the
 * neutral default.
 * @returns {import('../../../src/core/contracts.d.ts').BrandSystem}
 */
export function brandFixture() {
  return {
    id: contentId('brand', 'northwind'),
    sourceUrl: 'https://www.northwind-industrial.example',
    capturedAt: CAPTURED_AT,
    colors: [
      { role: 'primary', hex: '#0F3D2E', oklch: [0.33, 0.06, 160], source: 'extracted', contrastWithPair: 11.2 },
      { role: 'onPrimary', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 11.2 },
      { role: 'surface', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'extracted', contrastWithPair: 16.1 },
      { role: 'onSurface', hex: '#16181D', oklch: [0.22, 0.01, 264], source: 'extracted', contrastWithPair: 16.1 },
      { role: 'accent', hex: '#B4531A', oklch: [0.55, 0.13, 45], source: 'extracted', contrastWithPair: 4.9 },
      { role: 'onAccent', hex: '#FFFFFF', oklch: [1, 0, 0], source: 'derived', contrastWithPair: 4.9 },
      { role: 'border', hex: '#D9DCE1', oklch: [0.88, 0.01, 264], source: 'derived', contrastWithPair: 1.3 },
    ],
    faces: [
      { family: 'Georgia', fallbackStack: ['Georgia', 'Times New Roman', 'serif'], weightsSeen: [400, 700], role: 'display', metricDelta: { capHeight: 1.02, xHeight: 1.04, avgAdvance: 1.01 }, embeddable: false },
      { family: 'Arial', fallbackStack: ['Arial', 'Helvetica', 'sans-serif'], weightsSeen: [400, 600, 700], role: 'body', metricDelta: { capHeight: 1, xHeight: 1, avgAdvance: 1 }, embeddable: false },
      { family: 'Courier New', fallbackStack: ['Courier New', 'Courier', 'monospace'], weightsSeen: [400], role: 'mono', metricDelta: null, embeddable: false },
    ],
    logos: [],
    shape: { radiusPx: 6, borderWidthPx: 1, shadowLevel: 1 },
    imagery: { treatment: 'photographic', saturationBias: -0.05 },
    confidence: { colors: 0.86, faces: 0.74, logos: 0.3, shape: 0.8, imagery: 0.62 },
    manualOverrides: [],
  };
}

/**
 * The eight layouts, each with the model shape it is designed for. Every test
 * that says "for every layout" walks this.
 * @returns {{layout: string, specimen: any, renditions: any[], headline: string, subhead: string|null}[]}
 */
export function layoutCases() {
  const spec = specimen();
  return [
    {
      layout: 'splitBeforeAfter',
      specimen: spec,
      renditions: [localeFanout(1)[0]],
      headline: 'Their product page, localised for DACH',
      subhead: 'Same structure, same claims, market-appropriate copy.',
    },
    {
      layout: 'fanOut',
      specimen: spec,
      renditions: localeFanout(9),
      headline: 'One page, nine markets',
      subhead: 'Structure adapted per market, not translated word for word.',
    },
    {
      layout: 'stack',
      specimen: spec,
      renditions: approvalChain(),
      headline: 'The same asset through your review chain',
      subhead: 'Brand and claim rules holding at every state.',
    },
    {
      layout: 'fullBleed',
      specimen: spec,
      renditions: [heroRendition()],
      headline: 'Assembled from your own components',
      subhead: 'No new design system, no new asset library.',
    },
    {
      layout: 'sideNote',
      specimen: spec,
      renditions: channelVariants().slice(0, 2),
      headline: 'What changed, and why',
      subhead: 'Each note sits beside the block it is about.',
    },
    {
      layout: 'systemMap',
      specimen: spec,
      renditions: localeFanout(7),
      headline: 'How a page becomes nine',
      subhead: 'Locale fan-out',
    },
    {
      layout: 'quoteCard',
      specimen: spec,
      renditions: [],
      headline: 'What their own site already says',
      subhead: 'From the product page, unedited.',
    },
    {
      layout: 'contentsIndex',
      specimen: spec,
      renditions: channelVariants(),
      headline: 'What this proof covers',
      subhead: 'Twelve minutes, four scenes, three branches.',
    },
  ];
}
