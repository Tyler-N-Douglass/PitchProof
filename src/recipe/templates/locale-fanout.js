/**
 * `locale-fanout` — one source page, nine market renditions whose **structure**
 * differs, not only their strings (§9.1).
 *
 * What actually changes between the nine:
 *
 * - **Writing direction.** RTL markets render their prose as `raw` blocks
 *   carrying `dir="rtl"`, and every table row's cells are reversed, so the block
 *   list itself differs in type and in cell order — not merely in a CSS class.
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

import { LOCALES, localizeText, formatContractRows, legalPlacementLabel } from '../locales.js';
import { finish, bodyBlocks, legalLine, mapBlockText, cloneBlock, sectionHeading, slot } from '../blocks.js';
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
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @returns {import('../../core/contracts.d.ts').ContentBlock}
 */
function mirrorTable(block) {
  if (block.type !== 'table') return block;
  return { type: 'table', header: block.header, rows: block.rows.map((r) => r.slice().reverse()) };
}

/**
 * Wrap a prose block as a direction-carrying `raw` block. Balanced markup, no
 * network reference, no script — the emitter's scanner sees a plain element.
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @param {string} localeId
 * @returns {import('../../core/contracts.d.ts').ContentBlock}
 */
function asRtl(block, localeId) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (block.type === 'paragraph') {
    return { type: 'raw', html: `<p dir="rtl" lang="${localeId}">${esc(block.text)}</p>` };
  }
  if (block.type === 'heading') {
    return { type: 'raw', html: `<h${block.level} dir="rtl" lang="${localeId}">${esc(block.text)}</h${block.level}>` };
  }
  if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul';
    const items = block.items.map((it) => `<li>${esc(it)}</li>`).join('');
    return { type: 'raw', html: `<${tag} dir="rtl" lang="${localeId}">${items}</${tag}>` };
  }
  return block;
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

  return wanted.map((locale) => {
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = [];

    blocks.push(sectionHeading(`Locale format contract — ${locale.name}`, 2));
    const contract = { type: /** @type {const} */('table'), header: true, rows: formatContractRows(locale) };
    blocks.push(locale.dir === 'rtl' ? mirrorTable(contract) : contract);

    const localizedLegal = legal
      ? mapBlockText(cloneBlock(legal.block), (s) => localizeText(s, locale))
      : slot(`Legal line, ${legalPlacementLabel(locale.legalPlacement)}`);

    let ctaSeen = false;
    for (const block of body) {
      const localized = mapBlockText(cloneBlock(block), (s) => localizeText(s, locale));
      if (block.type === 'cta' && !ctaSeen) {
        ctaSeen = true;
        if (locale.legalPlacement === 'before-cta') {
          blocks.push(locale.dir === 'rtl' ? asRtl(localizedLegal, locale.id) : localizedLegal);
        }
      }
      if (localized.type === 'table' && locale.dir === 'rtl') { blocks.push(mirrorTable(localized)); continue; }
      blocks.push(locale.dir === 'rtl' ? asRtl(localized, locale.id) : localized);
    }

    if (locale.legalPlacement !== 'before-cta' || !ctaSeen) {
      blocks.push(locale.dir === 'rtl' ? asRtl(localizedLegal, locale.id) : localizedLegal);
    }

    const notes = [
      `Structure applied for ${locale.name} (${locale.endonym}).`,
      `Direction ${locale.dir}; date ${locale.datePattern}; number ${locale.numberPattern}; legal line ${legalPlacementLabel(locale.legalPlacement)}.`,
      'Text is reformatted, not translated: no word, number or claim was added.',
    ].join(' ');

    return finish({
      specimen,
      recipe: RECIPE,
      label: locale.id,
      blocks,
      notes,
    });
  });
}

/**
 * The structural facts a test — or the studio inspector — can compare across
 * renditions to show the fan-out changed shape and not only strings.
 * @param {import('../../core/contracts.d.ts').Rendition} rendition
 * @returns {{types: string[], legalIndex: number, rtlBlocks: number, contractRow: string[]}}
 */
export function structureOf(rendition) {
  const types = rendition.blocks.map((b) => b.type);
  const legalIndex = rendition.blocks.findIndex((b) => {
    const text = b.type === 'raw' ? b.html : b.type === 'paragraph' ? b.text : '';
    return /Legal line|©|\(c\)|rights reserved|Impressum|imprint|privacy|terms/i.test(String(text));
  });
  const rtlBlocks = rendition.blocks.filter((b) => b.type === 'raw' && /dir="rtl"/.test(b.html)).length;
  const table = rendition.blocks.find((b) => b.type === 'table');
  const contractRow = table && table.type === 'table'
    ? (table.rows.find((r) => r.some((c) => flatten(c) === 'Date' || flatten(c) === 'Number')) || []).slice()
    : [];
  return { types, legalIndex, rtlBlocks, contractRow };
}
