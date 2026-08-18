/**
 * Block helpers shared by the eight seed recipe templates.
 *
 * Every template is built from these, and every one of them is a *selection* or
 * a *reshaping* of the specimen. The only text this module originates is
 * structural labelling — the names of facets, the words "Draft" and "Approved",
 * the marker that a slot has no source content — and none of it can carry a
 * numeral, a quotation or a brand.
 *
 * `finish()` is the choke point: every rendition the library produces goes
 * through it, and it runs the §18.2 guard before `buildRendition` sees the
 * blocks. A template that grows a fabricated fact throws at construction.
 *
 * @module recipe/blocks
 */

import { blockText } from '../core/contracts.js';
import { flatten, titleCase } from './text.js';
import { buildRendition } from './provenance.js';
import { enforceNoFabricatedFacts } from './facts.js';

/**
 * The marker a template renders where the source has nothing to show. Saying
 * "no source content" out loud is the honest alternative to inventing a
 * plausible German street address (§18.2, §18.3).
 * @param {string} label
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function slot(label) {
  return { type: 'paragraph', text: `[${label} — no source content; supply before use]` };
}

/**
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @param {import('../core/contracts.d.ts').ContentBlock['type']} type
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function blocksOfType(specimen, type) {
  return (specimen.blocks || []).filter((b) => b && b.type === type);
}

/**
 * The line a page leads with: its first heading, or its title.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string}
 */
export function leadHeadline(specimen) {
  const headings = blocksOfType(specimen, 'heading');
  const first = headings.find((h) => flatten(h.text));
  if (first) return flatten(first.text);
  return flatten(specimen.title || '');
}

/**
 * The first paragraph with real text.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {string}
 */
export function leadParagraph(specimen) {
  const p = blocksOfType(specimen, 'paragraph').find((b) => flatten(b.text));
  return p ? flatten(p.text) : '';
}

/**
 * The specimen's primary call to action, if it has one.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').ContentBlock|null}
 */
export function leadCta(specimen) {
  const cta = blocksOfType(specimen, 'cta').find((b) => flatten(b.label));
  return cta || null;
}

/** Words that mark a paragraph as the page's legal or policy line. */
const LEGAL_MARKERS = /(©|\(c\)\s*\d|all rights reserved|terms of (use|service)|privacy (policy|notice)|imprint|impressum|legal notice|cookie)/i;

/**
 * The specimen's legal line, with its index, or `null`.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {{block: import('../core/contracts.d.ts').ContentBlock, index: number}|null}
 */
export function legalLine(specimen) {
  const blocks = specimen.blocks || [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.type !== 'paragraph' && b.type !== 'list') continue;
    const text = blockText(b).join(' ');
    if (LEGAL_MARKERS.test(text)) return { block: b, index: i };
  }
  return null;
}

/**
 * The specimen's body: every block that is not chrome-shaped, in source order.
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').ContentBlock[]}
 */
export function bodyBlocks(specimen) {
  const legal = legalLine(specimen);
  return (specimen.blocks || []).filter((b, i) => b && (!legal || i !== legal.index));
}

/**
 * The `MediaRef`s a block list actually references, in first-use order.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} blocks
 * @param {import('../core/contracts.d.ts').Specimen} specimen
 * @returns {import('../core/contracts.d.ts').MediaRef[]}
 */
export function mediaFor(blocks, specimen) {
  const byId = new Map((specimen.media || []).map((m) => [m.id, m]));
  /** @type {import('../core/contracts.d.ts').MediaRef[]} */
  const out = [];
  const seen = new Set();
  for (const b of blocks) {
    if (!b || b.type !== 'media') continue;
    const ref = byId.get(b.ref);
    if (ref && !seen.has(ref.id)) { seen.add(ref.id); out.push(ref); }
  }
  return out;
}

/**
 * Clone a block, so no rendition ever shares a mutable object with the specimen
 * it was derived from.
 * @template {import('../core/contracts.d.ts').ContentBlock} T
 * @param {T} block
 * @returns {T}
 */
export function cloneBlock(block) {
  switch (block.type) {
    case 'list': return /** @type {any} */({ type: 'list', ordered: block.ordered, items: block.items.slice() });
    case 'table': return /** @type {any} */({ type: 'table', header: block.header, rows: block.rows.map((r) => r.slice()) });
    default: return /** @type {any} */({ ...block });
  }
}

/**
 * Apply a text transform to every text run of a block, preserving its type.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @param {(s: string) => string} fn
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function mapBlockText(block, fn) {
  switch (block.type) {
    case 'heading': return { type: 'heading', level: block.level, text: fn(block.text) };
    case 'paragraph': return { type: 'paragraph', text: fn(block.text) };
    case 'list': return { type: 'list', ordered: block.ordered, items: block.items.map(fn) };
    case 'quote': return block.attribution
      ? { type: 'quote', text: fn(block.text), attribution: fn(block.attribution) }
      : { type: 'quote', text: fn(block.text) };
    case 'table': return { type: 'table', header: block.header, rows: block.rows.map((r) => r.map(fn)) };
    case 'cta': return { type: 'cta', label: fn(block.label), href: block.href };
    case 'media': return block.caption ? { type: 'media', ref: block.ref, caption: fn(block.caption) } : { type: 'media', ref: block.ref };
    case 'raw': return { type: 'raw', html: block.html };
    default: return block;
  }
}

/**
 * A section heading a template adds to organise a rendition. Structural text
 * only: never a claim, never a numeral.
 * @param {string} text
 * @param {1|2|3|4|5|6} [level]
 * @returns {import('../core/contracts.d.ts').ContentBlock}
 */
export function sectionHeading(text, level = 3) {
  return { type: 'heading', level, text: titleCase(text) };
}

/**
 * Build the rendition, with the §18.2 guard between the template and the model.
 *
 * @param {object} args
 * @param {import('../core/contracts.d.ts').Specimen} args.specimen
 * @param {import('../core/contracts.d.ts').Recipe} args.recipe
 * @param {string} args.label
 * @param {import('../core/contracts.d.ts').ContentBlock[]} args.blocks
 * @param {string[]} [args.structural]  bare integers the template legitimately emitted
 * @param {string[]} [args.extraSource] additional legitimate source strings (a brief)
 * @param {string|null} [args.notes]
 * @returns {import('../core/contracts.d.ts').Rendition}
 */
export function finish({ specimen, recipe, label, blocks, structural = [], extraSource = [], notes = null }) {
  enforceNoFabricatedFacts(blocks, specimen, { structural, extraSource, label: `${recipe.id} / ${label}` });
  return buildRendition({
    specimen,
    recipe,
    label,
    blocks,
    media: mediaFor(blocks, specimen),
    producedBy: 'template',
    notes,
  });
}
