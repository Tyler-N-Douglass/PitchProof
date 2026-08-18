/**
 * `volume-view` — one, then forty, then four hundred renditions as a density
 * visual, "to make scale physical rather than asserted" (§9.8).
 *
 * The whole recipe is an argument against a bullet point. "Scales to hundreds of
 * variants" is a claim; four hundred labelled tiles filling a slide is a thing
 * the room can see. So the tiers are rendered as real grids of real cells, not
 * as a number in a box.
 *
 * **Every cell is honest.** A cell's label is a locale tag crossed with a channel
 * code — both drawn from this lane's own vocabulary — so what the grid shows is
 * the combinatorial space the other seed recipes actually cover, not a decorative
 * texture. The cell order is drawn from the seeded PRNG substream
 * `recipe/volume-view`, which is the only randomness in L7 and is reproducible
 * from the project seed.
 *
 * The tier counts (one, forty, four hundred) are the §9.8 tiers and are the only
 * numerals the template emits. They are declared structural: they count the
 * artifact's own tiles and can be verified by counting them.
 *
 * @module recipe/templates/volume-view
 */

import { SeedBook, DEFAULT_SEED } from '../../core/prng.js';
import { LOCALES } from '../locales.js';
import { CHANNEL_BUDGETS } from '../budget.js';
import { finish, leadHeadline, sectionHeading } from '../blocks.js';
import { flatten } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'volume-view',
  name: 'Volume view',
  intent: 'Scale is a thing you can see filling a slide, not a number someone reads out.',
  inputKinds: ['page', 'article', 'product', 'campaign', 'document', 'image', 'fragment'],
  outputLabels: ['1 rendition', '40 renditions', '400 renditions'],
  adapterPrompt:
    'Enumerate the market-by-channel combinations this asset would be produced in at each scale tier. '
    + 'Return labels only; produce no copy, no statistic and no brand name.',
};

/** The §9.8 tiers, with the grid each is laid out on. */
export const TIERS = [
  { count: 1, columns: 1, label: '1 rendition' },
  { count: 40, columns: 8, label: '40 renditions' },
  { count: 400, columns: 20, label: '400 renditions' },
];

/** Two-letter channel codes, derived from the channel budgets this lane owns. */
export const CHANNEL_CODES = CHANNEL_BUDGETS.map((b) => ({
  id: b.id,
  code: b.id.split('-').map((p) => p[0].toUpperCase()).join('').slice(0, 2).padEnd(2, b.id[1].toUpperCase()),
  channel: b.channel,
}));

/**
 * The full combinatorial vocabulary: every locale crossed with every channel,
 * in a fixed order before shuffling.
 * @returns {string[]}
 */
export function combinationVocabulary() {
  /** @type {string[]} */
  const out = [];
  for (const locale of LOCALES) for (const ch of CHANNEL_CODES) out.push(`${locale.id}·${ch.code}`);
  return out;
}

/**
 * Cell labels for a tier, drawn deterministically from the seeded substream.
 * @param {number} count
 * @param {string|number|bigint} seed
 * @returns {string[]}
 */
export function cellsFor(count, seed = DEFAULT_SEED) {
  const vocabulary = combinationVocabulary();
  const gen = new SeedBook(seed).fresh(`recipe/${RECIPE.id}`);
  /** @type {string[]} */
  const out = [];
  while (out.length < count) {
    for (const cell of gen.shuffled(vocabulary)) {
      out.push(cell);
      if (out.length === count) break;
    }
  }
  return out;
}

/**
 * @param {string[]} cells
 * @param {number} columns
 * @returns {string[][]}
 */
function grid(cells, columns) {
  /** @type {string[][]} */
  const rows = [];
  for (let i = 0; i < cells.length; i += columns) {
    const row = cells.slice(i, i + columns);
    while (row.length < columns) row.push('');
    rows.push(row);
  }
  return rows;
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string|number|bigint} [options.seed]
 * @param {number[]} [options.tiers] restrict to a subset of tier counts
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const seed = options.seed === undefined ? DEFAULT_SEED : options.seed;
  const wanted = Array.isArray(options.tiers) && options.tiers.length
    ? TIERS.filter((t) => options.tiers.includes(t.count))
    : TIERS;
  const headline = leadHeadline(specimen) || flatten(specimen.title || '');
  const structural = TIERS.map((t) => String(t.count))
    .concat(TIERS.map((t) => String(t.columns)))
    .concat([String(LOCALES.length), String(CHANNEL_CODES.length), String(LOCALES.length * CHANNEL_CODES.length)]);

  return wanted.map((tier) => {
    const cells = cellsFor(tier.count, seed);
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = [
      sectionHeading(`One source, this many renditions — ${tier.label}`, 2),
      { type: 'paragraph', text: headline ? `Source: ${headline}` : 'Source: this specimen' },
      { type: 'table', header: false, rows: grid(cells, tier.columns) },
      {
        type: 'table',
        header: true,
        rows: [
          ['Axis', 'Values'],
          ['Markets', String(LOCALES.length)],
          ['Channels', String(CHANNEL_CODES.length)],
          ['Combinations available', String(LOCALES.length * CHANNEL_CODES.length)],
          ['Tiles shown', String(tier.count)],
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: CHANNEL_CODES.map((c) => `${c.code} — ${c.channel}`),
      },
      {
        type: 'paragraph',
        text: 'Each tile is one market crossed with one channel. Past the combination count the tiles repeat: '
          + 'the grid shows volume, not a unique enumeration, and says so rather than implying more coverage than exists.',
      },
    ];

    return finish({
      specimen,
      recipe: RECIPE,
      label: tier.label,
      blocks,
      structural,
      notes: `Density tier ${tier.label}, laid out ${tier.columns} across. Cell order drawn from PRNG substream recipe/${RECIPE.id}; the same project seed always produces the same grid.`,
    });
  });
}
