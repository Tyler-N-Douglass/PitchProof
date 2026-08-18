/**
 * `approval-chain` — the same asset at each review state, with **what each
 * reviewer actually sees and touches** (§9.6).
 *
 * The reframe here is that review is not a queue, it is a permission surface. So
 * every rendition carries three things: the asset as that reviewer sees it, the
 * field-level permission table for that role, and the open items that role is
 * accountable for closing.
 *
 * Two structural things change down the chain, and a test asserts both:
 *
 * - **What is visible.** A brand reviewer does not see the legal line; a legal
 *   reviewer does not see the side-rail feature list. The rendition's block list
 *   is genuinely shorter for those states, not merely styled down.
 * - **What is editable.** The permission table's second column changes per role,
 *   and the count of open items falls monotonically to zero at `Approved`.
 *
 * No reviewer is named. A named person on a slide is a fabricated attribution
 * (§18.2) and a privacy problem; the roles are named instead.
 *
 * @module recipe/templates/approval-chain
 */

import { finish, bodyBlocks, legalLine, cloneBlock, sectionHeading, blocksOfType } from '../blocks.js';
import { flatten } from '../text.js';

/** @type {import('../../core/contracts.d.ts').Recipe} */
export const RECIPE = {
  id: 'approval-chain',
  name: 'Approval chain',
  intent: 'Review is a permission surface: each reviewer sees a different asset and can touch a different part of it.',
  inputKinds: ['page', 'product', 'campaign', 'article', 'document'],
  outputLabels: ['Draft', 'Brand review', 'Legal review', 'Localization review', 'Approved'],
  adapterPrompt:
    'Show the supplied asset at each review state: draft, brand review, legal review, localisation review, '
    + 'approved. For each state, state what that role can see and edit. Name no individual. Add no content '
    + 'that is not in the source.',
};

/**
 * The chain. `sees` lists block types this role is shown; `edits` lists the
 * fields it may change; `opens` are the items it is accountable for closing.
 */
export const REVIEW_STATES = [
  {
    id: 'draft',
    label: 'Draft',
    role: 'Author',
    hides: [],
    permissions: [
      ['Headline', 'edit'], ['Body copy', 'edit'], ['Feature list', 'edit'],
      ['Quotation', 'edit'], ['Call to action', 'edit'], ['Legal line', 'read-only'],
    ],
    open: ['Headline agreed', 'Claims sourced', 'Action destination set'],
  },
  {
    id: 'brand',
    label: 'Brand review',
    role: 'Brand',
    hides: ['legal'],
    permissions: [
      ['Headline', 'edit'], ['Body copy', 'suggest'], ['Feature list', 'suggest'],
      ['Quotation', 'read-only'], ['Call to action', 'edit'], ['Legal line', 'hidden'],
    ],
    open: ['Claims sourced', 'Action destination set'],
  },
  {
    id: 'legal',
    label: 'Legal review',
    role: 'Legal',
    hides: ['list'],
    permissions: [
      ['Headline', 'read-only'], ['Body copy', 'suggest'], ['Feature list', 'hidden'],
      ['Quotation', 'edit'], ['Call to action', 'read-only'], ['Legal line', 'edit'],
    ],
    open: ['Claims sourced'],
  },
  {
    id: 'localization',
    label: 'Localization review',
    role: 'Localization',
    hides: [],
    permissions: [
      ['Headline', 'suggest'], ['Body copy', 'suggest'], ['Feature list', 'suggest'],
      ['Quotation', 'read-only'], ['Call to action', 'suggest'], ['Legal line', 'read-only'],
    ],
    open: ['Locale variants requested'],
  },
  {
    id: 'approved',
    label: 'Approved',
    role: 'Owner',
    hides: [],
    permissions: [
      ['Headline', 'locked'], ['Body copy', 'locked'], ['Feature list', 'locked'],
      ['Quotation', 'locked'], ['Call to action', 'locked'], ['Legal line', 'locked'],
    ],
    open: [],
  },
];

/**
 * @param {import('../../core/contracts.d.ts').Specimen} specimen
 * @param {object} [options]
 * @param {string[]} [options.states] restrict to a subset of state ids
 * @returns {import('../../core/contracts.d.ts').Rendition[]}
 */
export function render(specimen, options = {}) {
  const wanted = Array.isArray(options.states) && options.states.length
    ? REVIEW_STATES.filter((s) => options.states.includes(s.id))
    : REVIEW_STATES;

  const legal = legalLine(specimen);
  const body = bodyBlocks(specimen);
  const hasQuote = blocksOfType(specimen, 'quote').length > 0;

  return wanted.map((state) => {
    /** @type {import('../../core/contracts.d.ts').ContentBlock[]} */
    const blocks = [];
    blocks.push(sectionHeading(`${state.label} — what ${state.role} sees`, 2));

    for (const b of body) {
      if (state.hides.includes('list') && b.type === 'list') continue;
      blocks.push(cloneBlock(b));
    }
    if (legal && !state.hides.includes('legal')) blocks.push(cloneBlock(legal.block));

    blocks.push(sectionHeading(`What ${state.role} can touch`, 3));
    blocks.push({
      type: 'table',
      header: true,
      rows: [['Field', 'This reviewer']].concat(
        state.permissions
          .filter(([field]) => (field !== 'Quotation' || hasQuote) && (field !== 'Legal line' || legal !== null))
          .map(([field, mode]) => [field, mode]),
      ),
    });

    blocks.push(sectionHeading('Open items', 3));
    blocks.push(state.open.length
      ? { type: 'list', ordered: false, items: state.open.slice() }
      : { type: 'paragraph', text: 'No open items. The asset is released for use.' });

    return finish({
      specimen,
      recipe: RECIPE,
      label: state.label,
      blocks,
      notes: `Review state ${state.id}; role ${state.role}; hidden: ${state.hides.length ? state.hides.join(', ') : 'nothing'}; open items: ${state.open.length ? state.open.join('; ') : 'none'}. No individual is named.`,
    });
  });
}

/**
 * What a test — or the studio — can compare across the chain: visible block
 * types, the permission map, and the count of open items.
 * @param {import('../../core/contracts.d.ts').Rendition} rendition
 * @returns {{visibleTypes: string[], permissions: Map<string, string>, openItems: number}}
 */
export function reviewSurfaceOf(rendition) {
  const visibleTypes = rendition.blocks.map((b) => b.type);
  /** @type {Map<string, string>} */
  const permissions = new Map();
  let openItems = 0;
  rendition.blocks.forEach((b, i) => {
    if (b.type === 'table' && b.header && flatten(b.rows[0][1] || '') === 'This reviewer') {
      for (const row of b.rows.slice(1)) permissions.set(row[0], row[1]);
    }
    const prev = rendition.blocks[i - 1];
    if (b.type === 'list' && prev && prev.type === 'heading' && /open items/i.test(prev.text)) openItems = b.items.length;
  });
  return { visibleTypes, permissions, openItems };
}
