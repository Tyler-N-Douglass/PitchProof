/**
 * `brief-to-asset` — a one-paragraph brief becomes a structured, on-brand asset
 * (§9.4).
 *
 * Two renditions, because the pair is the argument: the brief as it arrived,
 * normalised into blocks, and the asset it becomes. Putting only the asset on a
 * slide asks the room to take the input on trust.
 *
 * The asset is *derived*, never authored. Its headline is the brief's first
 * sentence, title-cased. Its standfirst is the second sentence. Its key points
 * are the brief's own clauses, split on the punctuation the writer used. Its
 * call to action is the brief's imperative sentence if it has one, otherwise the
 * specimen's own call to action, otherwise a labelled empty slot. If the brief
 * says nothing about a thing, the asset says nothing about it — it does not fill
 * the gap with plausible copy, which is exactly the §18.2 line.
 *
 * @module recipe/templates/brief-to-asset
 */

import { blockText } from '../../core/contracts.js';
import { finish, leadCta, slot, sectionHeading, blocksOfType } from '../blocks.js';
import { sentences, titleCase, sentenceCase, flatten, firstClause } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'brief-to-asset',
  name: 'Brief to asset',
  intent: 'A paragraph of intent becomes a structured, on-brand asset without a round trip.',
  inputKinds: ['fragment', 'document', 'page', 'campaign'],
  outputLabels: ['Brief', 'Structured asset'],
  adapterPrompt:
    'Turn the supplied one-paragraph brief into a structured asset: headline, standfirst, key points and one '
    + 'call to action. Use only what the brief and the source page state. Invent no statistic, price, brand, '
    + 'customer name or quotation.',
};

/** Sentences that read as an instruction rather than a description. */
const IMPERATIVE = /^(get|start|try|book|request|learn|see|shop|buy|download|sign|contact|explore|discover|read|watch|join|subscribe|schedule|talk|find|view|browse|order|apply|register|create|build|compare|tell|show|make|drive|launch|announce|promote|invite)\b/i;

/**
 * The brief text: the caller's `brief` option, else the specimen's first
 * paragraph, else its title.
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {string} [brief]
 * @returns {string}
 */
export function briefText(specimen, brief) {
  if (typeof brief === 'string' && brief.trim()) return flatten(brief);
  const p = blocksOfType(specimen, 'paragraph').find((b) => flatten(b.text));
  if (p) return flatten(p.text);
  const anyText = (specimen.blocks || []).flatMap((b) => blockText(b)).find((t) => flatten(t));
  return flatten(anyText || specimen.title || '');
}

/**
 * Split a sentence into the clauses its own punctuation marks out.
 * @param {string} sentence
 * @returns {string[]}
 */
function clauses(sentence) {
  return sentence
    .split(/\s*[;·•]\s+|\s+—\s+|\s*,\s+(?:and\s+)?(?=\S)/)
    .map((c) => flatten(c).replace(/[.;,]$/, ''))
    .filter((c) => c.split(' ').length >= 2);
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string} [options.brief]
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const brief = briefText(specimen, options.brief);
  const parts = sentences(brief);
  const extraSource = [brief];

  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const briefBlocks = [
    sectionHeading('Brief as received', 2),
    { type: 'paragraph', text: brief || '[Brief — no source content; supply before use]' },
    {
      type: 'list',
      ordered: true,
      items: parts.length ? parts.map((s) => flatten(s)) : [flatten(brief)].filter(Boolean),
    },
  ];

  const headlineSource = parts[0] || brief;
  const headline = titleCase(firstClause(headlineSource).replace(/[.!?]$/, ''));
  const standfirst = parts[1] ? sentenceCase(parts[1]) : '';
  const pointSource = parts.slice(standfirst ? 2 : 1);
  const points = pointSource.flatMap(clauses).filter(Boolean);
  const imperative = parts.find((s) => IMPERATIVE.test(s.trim()));
  const cta = leadCta(specimen);

  /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
  const assetBlocks = [];
  assetBlocks.push({ type: 'heading', level: 1, text: headline || flatten(specimen.title || '') });
  if (standfirst) assetBlocks.push({ type: 'paragraph', text: standfirst });
  if (points.length) assetBlocks.push({ type: 'list', ordered: false, items: points });
  else assetBlocks.push(slot('Key points — the brief states only one sentence'));

  const media = blocksOfType(specimen, 'media');
  if (media.length) assetBlocks.push({ ...media[0] });

  if (imperative) {
    assetBlocks.push({ type: 'cta', label: titleCase(firstClause(imperative).replace(/[.!?]$/, '')), href: cta ? cta.href : null });
  } else if (cta) {
    assetBlocks.push({ type: 'cta', label: flatten(cta.label), href: cta.href });
  } else {
    assetBlocks.push(slot('Call to action — the brief names no action'));
  }

  return [
    finish({
      specimen,
      recipe: RECIPE,
      label: 'Brief',
      blocks: briefBlocks,
      extraSource,
      notes: 'The brief exactly as supplied, split into its own sentences. Nothing added.',
    }),
    finish({
      specimen,
      recipe: RECIPE,
      label: 'Structured asset',
      blocks: assetBlocks,
      extraSource,
      notes: 'Headline, standfirst, key points and action are all derived from the brief\'s own sentences and clauses; empty slots are labelled rather than filled.',
    }),
  ];
}
