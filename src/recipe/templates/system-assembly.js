/**
 * `system-assembly` — the same content assembled from design-system components
 * at three breakpoints (§9.3).
 *
 * The claim under test is that a page is not a page but an assembly: named
 * components, filled from named slots, re-composing themselves at each
 * breakpoint. So each rendition carries two things the eye can check side by
 * side — the **component map** (which component takes which source block) and
 * the **assembly itself**, composed differently at that width.
 *
 * The three renditions differ structurally, not decoratively:
 *
 * | breakpoint | component map | body |
 * |---|---|---|
 * | sm (390px) | a `list`, because a table does not survive 390px | single stack, media last |
 * | md (1024px) | a two-column `table` | paired stack, media inline |
 * | lg (1600px) | a three-column `table` adding the region each component sits in | media hoisted above the fold, supporting list becomes a side rail |
 *
 * The breakpoint widths are the only numerals the template emits, and they are
 * declared structural: they are §4 `BREAKPOINTS` values describing the artifact's
 * own rendering, verifiable by measuring the artifact (see `facts.js`).
 *
 * @module recipe/templates/system-assembly
 */

import { BREAKPOINTS } from '../../core/contracts.js';
import { finish, bodyBlocks, leadHeadline, leadParagraph, blocksOfType, cloneBlock, sectionHeading } from '../blocks.js';
import { flatten, splitAtChars } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'system-assembly',
  name: 'System assembly',
  intent: 'This page is an assembly of governed components, and it re-composes itself at every breakpoint.',
  inputKinds: ['page', 'product', 'campaign', 'article'],
  outputLabels: BREAKPOINTS.map((b) => `${b.id} — ${b.width}px`),
  adapterPrompt:
    'Re-express the supplied page as an assembly of named design-system components at the given viewport '
    + 'width. Name each component and the source block that fills it, then show the composed result. '
    + 'Introduce no content that is not in the source.',
};

/** The component vocabulary. Structural names only — no product is named. */
const COMPONENTS = {
  heading: 'Heading block',
  paragraph: 'Prose block',
  list: 'Feature list',
  quote: 'Pull quote',
  table: 'Spec table',
  cta: 'Action button',
  media: 'Media frame',
  raw: 'Embed frame',
};

/**
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @returns {string}
 */
function componentFor(block) {
  if (block.type === 'heading') return block.level === 1 ? 'Hero heading' : COMPONENTS.heading;
  return COMPONENTS[block.type] || 'Content block';
}

/**
 * A one-line preview of a block's own text, for the component map.
 * @param {import('../../core/contracts.d.ts').ContentBlock} block
 * @returns {string}
 */
function preview(block) {
  switch (block.type) {
    case 'heading': return splitAtChars(flatten(block.text), 48).kept;
    case 'paragraph': return splitAtChars(flatten(block.text), 48).kept;
    case 'list': return splitAtChars(flatten(block.items.join(' · ')), 48).kept;
    case 'quote': return splitAtChars(flatten(block.text), 48).kept;
    case 'cta': return flatten(block.label);
    case 'media': return flatten(block.caption || block.ref);
    case 'table': return splitAtChars(flatten((block.rows[0] || []).join(' · ')), 48).kept;
    default: return '';
  }
}

/** Which region of the layout a component occupies at the widest breakpoint. */
function regionFor(block, index) {
  if (block.type === 'media') return 'above the fold';
  if (block.type === 'cta') return 'action rail';
  if (block.type === 'list') return 'side rail';
  return index === 0 ? 'masthead' : 'main column';
}

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string[]} [options.breakpoints] restrict to a subset of breakpoint ids
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const wanted = Array.isArray(options.breakpoints) && options.breakpoints.length
    ? BREAKPOINTS.filter((b) => options.breakpoints.includes(b.id))
    : BREAKPOINTS;

  const body = bodyBlocks(specimen);
  const headline = leadHeadline(specimen);
  const lead = leadParagraph(specimen);
  const media = blocksOfType(specimen, 'media');
  const lists = blocksOfType(specimen, 'list');
  const structural = BREAKPOINTS.map((b) => `${b.width}px`).concat(BREAKPOINTS.map((b) => String(b.width)));

  return wanted.map((bp) => {
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = [];
    blocks.push(sectionHeading(`Component map — ${bp.id}`, 2));

    if (bp.id === 'sm') {
      blocks.push({
        type: 'list',
        ordered: true,
        items: body.map((b) => `${componentFor(b)} — ${preview(b)}`.trim()),
      });
    } else if (bp.id === 'md') {
      blocks.push({
        type: 'table',
        header: true,
        rows: [['Component', 'Source block']].concat(body.map((b) => [componentFor(b), preview(b)])),
      });
    } else {
      blocks.push({
        type: 'table',
        header: true,
        rows: [['Component', 'Source block', 'Region']].concat(body.map((b, i) => [componentFor(b), preview(b), regionFor(b, i)])),
      });
    }

    blocks.push(sectionHeading(`Assembled at ${bp.width}px`, 2));

    if (bp.id === 'sm') {
      // Narrow: one linear stack, prose first, media last, no side rail.
      for (const b of body) { if (b.type !== 'media') blocks.push(cloneBlock(b)); }
      for (const m of media) blocks.push(cloneBlock(m));
    } else if (bp.id === 'md') {
      // Medium: source order preserved, media inline where it sits.
      for (const b of body) blocks.push(cloneBlock(b));
    } else {
      // Wide: media hoists above the fold, the feature list becomes a side rail
      // rendered as a two-column table beside the prose.
      for (const m of media) blocks.push(cloneBlock(m));
      blocks.push({ type: 'heading', level: 1, text: headline });
      if (lead) blocks.push({ type: 'paragraph', text: lead });
      if (lists.length) {
        blocks.push({
          type: 'table',
          header: true,
          rows: [['Side rail', 'Main column']].concat(
            lists[0].items.map((item, i) => [item, preview(body[i] || body[body.length - 1] || lists[0])]),
          ),
        });
      }
      for (const b of body) {
        if (b.type === 'media' || b.type === 'list') continue;
        if (b.type === 'heading' && flatten(b.text) === headline) continue;
        if (b.type === 'paragraph' && flatten(b.text) === lead) continue;
        blocks.push(cloneBlock(b));
      }
    }

    return finish({
      specimen,
      recipe: RECIPE,
      label: `${bp.id} — ${bp.width}px`,
      blocks,
      structural,
      notes: `Assembled from design-system components at ${bp.width}px. Component map is a ${bp.id === 'sm' ? 'list' : 'table'}; composition order and region assignment differ per breakpoint.`,
    });
  });
}
