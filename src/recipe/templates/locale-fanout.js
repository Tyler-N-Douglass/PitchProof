/**
 * `locale-fanout` — one source page, nine market renditions whose **structure**
 * differs, not only their strings (§9.1).
 *
 * What actually changes between the nine:
 *
 * - **Writing direction.** Every block a rendition carries declares the market's
 *   direction on the block itself, and an RTL market's table rows have their
 *   cells reversed, so the block list differs in direction and in cell order —
 *   not merely in a CSS class.
 *
 *   Until finding C8 this was done by wrapping RTL prose in `raw` blocks
 *   carrying `dir="rtl"`. That was wrong in a way that only showed up two lanes
 *   downstream: §8 forbids a layout from presenting a `raw` block as markup, so
 *   the whole ar-SA rendition was flattened to plain text under a caption
 *   reading "Source markup, shown as text" — the deck describing the difference
 *   in a table row instead of showing it, and mislabelling this lane's own
 *   output as the prospect's captured page source. Typed blocks carrying the
 *   optional `dir`/`lang` extensions say the same thing in a form a layout can
 *   act on. See D-L7-18.
 * - **Legal-line placement.** Germany and Japan put the legal line immediately
 *   above the call to action; the rest keep it in the footer. The block's index
 *   in the rendition differs accordingly, which is the thing a localisation lead
 *   checks first.
 * - **Format contract.** Each rendition opens its structural card with the
 *   market's date pattern, number pattern, currency placement, name order,
 *   address field order, plural categories, quotation marks and punctuation
 *   spacing. Every value is a digit-free pattern or a category name.
 * - **The prose itself is reformatted, not translated.** Dates are reordered
 *   into the market's order, numbers regrouped with the market's separators,
 *   currency symbols moved, quotation marks swapped, French narrow spaces
 *   inserted. Every digit that comes out was already in the source.
 *
 * The recipe never translates, because the tool has no translator and inventing
 * one would be inventing content. It shows the *shape* nine markets impose, on
 * the prospect's own page, which is the claim that actually needs proving.
 *
 * @module recipe/templates/locale-fanout
 */

import { LOCALES, localizeText, formatContractRows, legalPlacementLabel, sourceLanguage } from '../locales.js';
import {
  finish, bodyBlocks, legalLine, mapBlockText, cloneBlock, sectionHeading, slot,
  withDirection, carryFields, TOOL_LANG,
} from '../blocks.js';
import { flatten } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'locale-fanout',
  name: 'Locale fan-out',
  intent: 'Nine markets are nine different page structures, not nine translations of one.',
  inputKinds: ['page', 'article', 'product', 'campaign'],
  outputLabels: LOCALES.map((l) => l.id),
  adapterPrompt:
    'Re-render the supplied page for the market named in `label`. Change structure, not only strings: '
    + 'date and number formats, currency placement, name order, address field order, legal-line placement, '
    + 'plural categories, quotation marks and writing direction. Do not introduce any number, statistic, '
    + 'price, brand name, customer name or quotation that is not present in the source.',
};

/**
 * Reverse the cells of every row, for a right-to-left rendition.
 *
 * Another rebuild, so it carries by default rather than naming what it keeps
 * (`carryFields`). Reversing the column order changes the row arrays and nothing
 * else about the block, so `rows` is the only field it owns.
 *
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @returns {import('../../core/contracts.d.ts').ContentBlock}
 */
function mirrorTable(block) {
  if (block.type !== 'table') return block;
  return carryFields(block, { type: 'table', header: block.header, rows: block.rows.map((r) => r.slice().reverse()) }, ['rows']);
}

/**
 * Mark a block with the market's writing direction and the language its text is
 * actually in.
 *
 * Two arguments, and the pairing is the whole judgment call (D-L7-18):
 *
 * - `dir` is the **market's**. It is the structural fact this recipe genuinely
 *   produced — the ar-SA rendition of a page really is laid out right to left —
 *   and it is what §9.1 asks the deck to show rather than describe.
 * - `lang` is the **source's**, never the market's. The copy is reformatted, not
 *   translated, so an ar-SA rendition of an English page is still English text.
 *   Marking it `lang="ar-SA"` would be a claim about the content that is false,
 *   which is §18.2 territory, and would additionally hand a screen reader an
 *   Arabic voice for English words. Where the specimen declares no language,
 *   nothing is claimed.
 *
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @param {import('../locales.js').LocaleModel} locale
 * @param {string|null} lang
 * @returns {import('../../core/contracts.d.ts').ContentBlock}
 */
function directed(block, locale, lang) {
  return withDirection(block, { dir: locale.dir, lang });
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string[]} [options.locales] restrict to a subset, in order
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const wanted = Array.isArray(options.locales) && options.locales.length
    ? LOCALES.filter((l) => options.locales.includes(l.id))
    : LOCALES;

  const legal = legalLine(specimen);
  const body = bodyBlocks(specimen);

  // The language the prospect's own words are in. Every source-derived block is
  // marked with it; the tool's own structural labels are marked `en`, which is
  // what they are. Neither is ever the market's tag — see `directed`.
  const lang = sourceLanguage(specimen);

  return wanted.map((locale) => {
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = [];

    // The card heading and the format-contract table are the studio's words, so
    // they carry the market's direction and the tool's language, not the
    // source's.
    blocks.push(directed(sectionHeading(`Locale format contract — ${locale.name}`, 2), locale, TOOL_LANG));
    const contract = { type: /** @type {const} */('table'), header: true, rows: formatContractRows(locale) };
    blocks.push(directed(locale.dir === 'rtl' ? mirrorTable(contract) : contract, locale, TOOL_LANG));

    // A legal line the source did not have is a labelled empty slot, and the
    // slot's words are the tool's, not the prospect's (§18.2, §18.3).
    const localizedLegal = legal
      ? directed(mapBlockText(cloneBlock(legal.block), (s) => localizeText(s, locale)), locale, lang)
      : directed(slot(`Legal line, ${legalPlacementLabel(locale.legalPlacement)}`), locale, TOOL_LANG);

    let ctaSeen = false;
    for (const block of body) {
      const localized = mapBlockText(cloneBlock(block), (s) => localizeText(s, locale));
      if (block.type === 'cta' && !ctaSeen) {
        ctaSeen = true;
        if (locale.legalPlacement === 'before-cta') blocks.push(localizedLegal);
      }
      const shaped = localized.type === 'table' && locale.dir === 'rtl' ? mirrorTable(localized) : localized;
      blocks.push(directed(shaped, locale, lang));
    }

    if (locale.legalPlacement !== 'before-cta' || !ctaSeen) blocks.push(localizedLegal);

    const notes = [
      `Structure applied for ${locale.name} (${locale.endonym}).`,
      `Direction ${locale.dir}; date ${locale.datePattern}; number ${locale.numberPattern}; legal line ${legalPlacementLabel(locale.legalPlacement)}.`,
      'Text is reformatted, not translated: no word, number or claim was added.',
      locale.dir === 'rtl'
        ? 'The layout is the market\u2019s; the words are still the source\u2019s, which is why they read left to right inside a right-to-left page.'
        : null,
    ].filter(Boolean).join(' ');

    return finish({
      specimen,
      recipe: RECIPE,
      label: locale.id,
      blocks,
      notes,
      dir: locale.dir,
      // No rendition-level `lang`: a rendition mixes the source's language with
      // the tool's own labels, so no single tag is true of the whole of it. That
      // asymmetry is the argument for carrying language on the block and
      // direction on both (D-L7-18).
    });
  });
}

/**
 * The structural facts a test — or the studio inspector — can compare across
 * renditions to show the fan-out changed shape and not only strings.
 *
 * `signature` is the comparison that matters and the one finding C8 taught this
 * module to make. Before the fix, direction was encoded in the *block type* —
 * RTL prose was a `raw` block — so `types` alone distinguished ar-SA from en-US,
 * and it did so by the very encoding that made the rendition unrenderable.
 * Direction now rides on the block, where a layout can act on it, and the
 * structural signature has to look at the block rather than only its type.
 *
 * @param {import('../../core/contracts.d.ts').Rendition} rendition
 * @returns {{types: string[], dirs: (string|null)[], langs: (string|null)[], signature: string, legalIndex: number, rtlBlocks: number, rawBlocks: number, contractRow: string[]}}
 */
export function structureOf(rendition) {
  const blocks = rendition.blocks || [];
  const types = blocks.map((b) => b.type);
  const dirs = blocks.map((b) => (/** @type {any} */(b).dir || null));
  const langs = blocks.map((b) => (/** @type {any} */(b).lang || null));
  const signature = blocks
    .map((b, i) => `${b.type}:${dirs[i] || '-'}${b.type === 'table' ? `:${(b.rows[0] || []).join('|')}` : ''}`)
    .join(',');
  const legalIndex = blocks.findIndex((b) => {
    const text = b.type === 'raw' ? b.html : b.type === 'paragraph' ? b.text : '';
    return /Legal line|©|\(c\)|rights reserved|Impressum|imprint|privacy|terms/i.test(String(text));
  });
  const rtlBlocks = blocks.filter((b) => /** @type {any} */(b).dir === 'rtl').length;
  const rawBlocks = blocks.filter((b) => b.type === 'raw').length;
  const table = blocks.find((b) => b.type === 'table');
  const contractRow = table && table.type === 'table'
    ? (table.rows.find((r) => r.some((c) => flatten(c) === 'Date' || flatten(c) === 'Number')) || []).slice()
    : [];
  return { types, dirs, langs, signature, legalIndex, rtlBlocks, rawBlocks, contractRow };
}
